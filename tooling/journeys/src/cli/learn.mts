/**
 * `journeys learn` — record, learn what varies, and prove the mask holds.
 *
 * ```
 * journeys learn --journey J4                     all of J4's walks
 * journeys learn --journey J4 --persona common    one walk
 * journeys learn --journey J4 --relearn           start every mask from nothing
 * journeys learn … --defer-delta                  a batch caller runs the delta once
 * ```
 *
 * ## Three passes over one stack, and only the third gates
 *
 * | pass | does | its contract |
 * | --- | --- | --- |
 * | 1. match | compares each step with the committed reference under the committed mask | a step that matches **keeps the committed image**; one that does not becomes the reference |
 * | 2. discover | runs again on the **same build** and diffs against pass 1 | whatever differs between two runs of identical code joins that step's mask |
 * | 3. verify | runs normally, masks applied | **the only pass that proves anything**; red exits 1 |
 *
 * A red pass 1 or 2 is reported and does not stop the run: a journey that broke
 * at step 5 photographed four real screens, and those deserve masks. A **dead
 * stack** is different — steps either side of it photograph a page that is not
 * working — so after each learning pass the stack is probed, and if it did not
 * survive, the evidence is put back as it was and nothing is learned (#550).
 *
 * ## An abort leaves the committed evidence as it was
 *
 * Every journey folder the run can touch, and the index, is copied aside
 * before pass 1. A reset the host refuses, a stack that died, or an interrupt —
 * anything that stops the run before pass 3 — restores all of it: screenshots,
 * masks, narratives, `run.json`. Once pass 3 has run, the result stands (a red
 * pass 3 keeps its union, because running again is how a mask converges).
 *
 * ## Preconditions, inside the command
 *
 * The load gate runs **before** the stack starts: a refusal that had already
 * started a stack would have taken the ports it is telling somebody not to take.
 * A check followed by an action is a race; the gate is the action's first step.
 * Refused → exit 75 (`EX_TEMPFAIL`): held, nothing touched, retry later.
 *
 * Learning in parallel checkouts is a pessimization, not a speed-up: each cold
 * tree compiles at the same instant and a red pass 1 still writes masks. One
 * warm checkout, one journey at a time.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import { censusTable, judge, maskCensus } from "../learn/mask-census.mts";
import { MAX_DECLARED_BOX, MAX_STEP_COVERAGE } from "../mask/boxes.mts";
import { check, overrideReason } from "../stack/load-gate.mts";
import { checkoutOf, checkoutOfPid } from "../stack/ports.mts";
import { BACKUP_DIR, backupEvidence, putBack } from "../learn/evidence-backup.mts";
import { runPasses } from "../learn/passes.mts";
import { controlAttempt, probeStack, refusal } from "../stack/probe.mts";
import { STACK_STAMP, readStackStamp } from "../stack/stamp.mts";
import { EXTERNAL_VAR, freeStackPorts, resolveStackUrls } from "../stack/urls.mts";
import { DELTA_CLI, STACK_CLI } from "./paths.mts";
import { closingLine } from "./summary.mts";
import { runPlaywright } from "./playwright-run.mts";
import { selectSpecs } from "./select.mts";

/** Held, nothing done — `EX_TEMPFAIL`. A batch caller retries the same journey on it. */
export const HOLD = 75;

const SINGLE_RUN = "journeys test --journey <id> --persona <persona>";
const READY_SECONDS = 180;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function main(): Promise<number> {
  const processStart = Date.now();
  const root = journeysRoot();
  const config = await loadJourneysConfig(root);
  const argv = process.argv.slice(2);
  const relearn = argv.includes("--relearn");
  const deferDelta = argv.includes("--defer-delta");

  let selected;
  try {
    selected = selectSpecs(
      argv.filter((a) => a !== "--relearn" && a !== "--defer-delta"),
      root,
      config.specDir,
    );
  } catch (error) {
    console.error(`\n${(error as Error).message}\n`);
    return 1;
  }
  const args = [...selected.files, ...selected.rest];
  if (selected.asked.journey || selected.asked.persona) {
    const what = [selected.asked.journey, selected.asked.persona].filter(Boolean).join(" · ");
    console.warn(`\n▸ ${what} — ${selected.files.length} spec(s) will be learned against.\n`);
  }

  // The precondition, before anything is started.
  const marker = config.ports.marker;
  const load = check(
    checkoutOf(root, existsSync, marker),
    (pid) => checkoutOfPid(pid, marker),
    config.recordingProcessNames,
  );
  if (load.kind === "stop") {
    console.error(`\n✗ Not recording — ${load.why}.`);
    console.error(
      '\n  Wait for it to settle, or say why it is safe:\n      JOURNEY_LOAD_OVERRIDE="<reason>" journeys learn …\n',
    );
    return HOLD;
  }
  if (load.kind === "cannot-ask")
    console.warn(`\n  Load could not be read — ${load.why}. Recording anyway.\n`);
  const reason = overrideReason();
  if (reason) console.warn(`\n  Load gate overridden: ${reason}\n`);

  const urls = resolveStackUrls({
    cwd: root,
    ports: config.ports,
    scratchRoot: config.scratchRoot,
  });
  // This command starts the stack itself, before Playwright — so it is the one
  // path the config's sweep never covers.
  freeStackPorts(urls, { scratchDir: join(root, config.scratchRoot), marker: config.ports.marker });

  const evidence = join(root, config.evidenceRoot);
  mkdirSync(evidence, { recursive: true });
  const startedAt = Date.now();

  const server = spawn(process.execPath, [STACK_CLI], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  let stackExit: number | null = null;
  server.on("exit", (code) => {
    stackExit = code ?? 1;
  });

  const passes: Array<{ pass: string; seconds: number; status: number }> = [];
  let learned = false;

  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  const done = async (code: number): Promise<number> => {
    if (stackExit === null) {
      server.kill("SIGTERM");
      // Wait for the host to finish tearing down, so the next run does not meet
      // its own orphan on the ports. Bounded: a host that ignores SIGTERM is the
      // sweep's to take next time.
      await Promise.race([exited, sleep(15_000)]);
    }
    let delta = 0;
    const deltaStart = Date.now();
    if (learned && deferDelta)
      console.warn("\n  Delta report deferred — the caller runs it once for the batch.\n");
    if (learned && !deferDelta) {
      delta =
        spawnSync(process.execPath, [DELTA_CLI, "--report"], { cwd: root, stdio: "inherit" })
          .status ?? 1;
    }
    if (passes.length > 0) {
      try {
        mkdirSync(join(root, config.reportRoot), { recursive: true });
        appendFileSync(
          join(root, config.reportRoot, "timing.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            selector:
              [selected.asked.journey, selected.asked.persona].filter(Boolean).join(" ") || "(all)",
            stack: readStackStamp(join(root, config.scratchRoot)).name,
            relearn,
            deferDelta,
            passes,
            totalSeconds: Math.round((Date.now() - processStart) / 1000),
            deltaSeconds: Math.round((Date.now() - deltaStart) / 1000),
            passSeconds: passes.reduce((n, p) => n + p.seconds, 0),
            cleanRunSeconds: passes.find((p) => p.pass.startsWith("pass 3"))?.seconds ?? null,
            exit: code,
          }) + "\n",
        );
      } catch {
        // A timing nobody can write is a silence, not a failure.
      }
    }
    return code === 0 ? delta : code;
  };

  // Ready means *this* stack wrote its stamp — not a stale one, not merely a port answering.
  const stampFile = join(root, config.scratchRoot, STACK_STAMP);
  let ready = false;
  for (let waited = 0; waited < READY_SECONDS * 10 && stackExit === null && !ready; waited++) {
    if (existsSync(stampFile)) {
      try {
        const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as {
          pid?: number;
          readyAt?: number;
        };
        ready = stamp.pid === server.pid && (stamp.readyAt ?? 0) >= startedAt;
      } catch {
        // Half-written; read it again in a moment.
      }
    }
    if (!ready) await sleep(100);
  }
  if (!ready) {
    console.error(
      stackExit !== null
        ? `\nThe stack exited with ${stackExit} before it was ready. Nothing was learned and no ` +
            "recording was touched; its own refusal is above."
        : `\nThe stack was not ready within ${READY_SECONDS}s. Nothing was learned. Its output is above.`,
    );
    return done(1);
  }

  const play = (label: string, learning: boolean): number => {
    console.warn(`\n▸ ${label}\n`);
    const t0 = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env, [EXTERNAL_VAR]: "1" };
    for (const name of ["JOURNEY_MASKS", "JOURNEY_MASK_RECORD", "JOURNEY_RELEARN"])
      delete env[name];
    if (learning) {
      env.JOURNEY_MASKS = "1";
      // Pass 1 only: pass 2 must union onto pass 1, or it learns half.
      if (relearn && label.startsWith("pass 1")) env.JOURNEY_RELEARN = "1";
      // Pass 1 matches; it does not learn.
      if (label.startsWith("pass 1")) env.JOURNEY_MASK_RECORD = "1";
    }
    const status = runPlaywright(root, config.playwrightConfig, args, env);
    passes.push({
      pass: label.split(" — ")[0] ?? label,
      seconds: Math.round((Date.now() - t0) / 1000),
      status,
    });
    return status;
  };

  const reset = async (): Promise<boolean> => {
    const answer = await fetch(`${urls.controlUrl}/reset`, { method: "POST" }).catch(() => null);
    if (answer?.ok) return true;
    console.error(
      `\n✗ The stack host did not reset — ${urls.controlUrl}/reset ${answer ? `answered ${answer.status}` : "never answered"}.\n` +
        "  That says the control channel is not there. It does NOT say the app's database failed:\n" +
        "  the host exits whole when the app cannot bind its port. Read its output above.\n",
    );
    return false;
  };

  /*
   * Everything the run can touch is copied aside before pass 1, and every abort
   * before verification — a reset refused, a stack that died, an interrupt —
   * puts it back. Until pass 3 has run, nothing this run wrote is allowed to
   * stay in the committed tree (learn/passes.mts).
   */
  const outcome = await runPasses({
    backup: () =>
      backupEvidence(evidence, join(root, config.scratchRoot, BACKUP_DIR), selected.asked.journey),
    reset,
    play: (label, learning) => {
      const status = play(label, learning);
      if (learning && status !== 0)
        console.warn(`\n  ${label.split(" — ")[0]} was red; masks are still learned\n`);
      return status;
    },
    probe: () => probeStack(controlAttempt(urls.controlUrl)),
    onInterrupt: (undo) => {
      const quit = (signal: NodeJS.Signals) => {
        const undone = undo();
        console.error(
          `\n✗ ${signal} before the mask was verified — nothing was learned.\n` +
            putBack(undone, config.evidenceRoot),
        );
        if (stackExit === null) server.kill("SIGTERM");
        process.exit(130);
      };
      process.once("SIGINT", quit);
      process.once("SIGTERM", quit);
      return () => {
        process.off("SIGINT", quit);
        process.off("SIGTERM", quit);
      };
    },
  });
  if (outcome.kind === "aborted") {
    if (outcome.why.kind === "stack")
      console.error(
        refusal(outcome.pass, outcome.why.verdict, outcome.undone, urls.controlUrl, {
          evidenceRoot: config.evidenceRoot,
          stackName: "the journey stack",
        }),
      );
    else
      console.error(
        `  Nothing was learned: the run stopped before pass ${outcome.pass}.\n` +
          putBack(outcome.undone, config.evidenceRoot),
      );
    return done(1);
  }
  const { validated, redLearningPasses } = outcome;
  learned = true;
  /*
   * From here the run stands, green or red. A red pass 3 keeps what was
   * learned on purpose: the mask is a union, and the documented next step is
   * to run again — the delta report and the pull request review it.
   */
  outcome.finish();

  const rows = maskCensus(evidence, startedAt);
  console.warn(`\n${censusTable(rows).join("\n")}`);
  const unexercised = rows.filter((r) => r.unexercised.length > 0);
  if (unexercised.length > 0) {
    console.warn(
      `\n${unexercised.reduce((n, r) => n + r.unexercised.length, 0)} declared box(es) have never absorbed a ` +
        "difference. Expected on the day a date is recorded, and worth deleting if it survives a night:",
    );
    for (const row of unexercised) {
      for (const box of row.unexercised)
        console.warn(`  ${box.from.replace(/\[\d+\]$/, "")}  ${row.path}/${row.shot}`);
    }
  }

  const evidenceNote = (rs: { path: string; shot: string }[]) =>
    "\n\nThe two learning passes and their diff, per step:\n" +
    rs
      .map(
        (r) => `  ${config.scratchRoot}/mask-evidence/${r.path}/${r.shot.replace(/\.png$/, "")}/`,
      )
      .join("\n");

  if (validated !== 0) {
    console.error(
      "\nThe mask does not hold: pass 3 ran with it applied and was red. Either something varies in a\n" +
        "way two runs did not show — run this again, the mask is a union — or a step is genuinely changing.",
    );
    return done(1);
  }
  const { without, tooBig, fatDeclared, stale } = judge(rows);
  if (tooBig.length > 0) {
    console.error(
      `\n${tooBig.length} step(s) hide more than ${(MAX_STEP_COVERAGE * 100).toFixed(0)}% of the page in learned boxes:\n` +
        tooBig.map((r) => `  ${(r.learned * 100).toFixed(1)}%  ${r.path}/${r.shot}`).join("\n") +
        "\nA box that has crept across a card passes every comparison for ever." +
        evidenceNote(tooBig),
    );
    return done(1);
  }
  if (fatDeclared.length > 0) {
    console.error(
      `\n${fatDeclared.length} step(s) carry a declared box wider than ${(MAX_DECLARED_BOX * 100).toFixed(0)}% of the page:\n` +
        fatDeclared
          .map(
            (r) =>
              `  ${(r.widestDeclared * 100).toFixed(1)}%  ${r.path}/${r.shot}  ${r.widestDeclaredFrom ?? ""}`,
          )
          .join("\n") +
        "\nUsually the attribute is on the row or cell rather than the value inside it." +
        evidenceNote(fatDeclared),
    );
    return done(1);
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} mask(s) were learned by an older rule and not relearned — still applied, and looser:\n` +
        stale.map((r) => `  ${r.path}/${r.shot}`).join("\n"),
    );
    return done(1);
  }
  if (without.length > 0) {
    console.error(
      `\n${without.length} step(s) still have no mask, so nothing gates them:\n` +
        without.map((r) => `  ${r.path}/${r.shot}`).join("\n") +
        "\nIf they are new, run this again — the first pass had nothing to compare against.",
    );
    return done(1);
  }

  console.warn(closingLine(redLearningPasses, { singleRun: SINGLE_RUN }));
  return done(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
