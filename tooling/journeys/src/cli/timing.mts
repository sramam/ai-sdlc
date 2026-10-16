/**
 * `journeys timing` — re-record journeys one at a time, measuring each.
 *
 * ```
 * journeys timing               every recorded journey, most steps first
 * journeys timing J1 J7         only these
 * journeys timing --relearn     throw every mask away and learn afresh
 * journeys timing --dwell 1500  with the timed motion watch, for an audit
 * ```
 *
 * **One at a time, and only when the machine is quiet** — a learning pass in
 * parallel checkouts is a pessimization that can learn a permanently wrong
 * mask. The wait is inside the loop, so it is a precondition rather than a check
 * somebody then acts on.
 *
 * **A hold holds this journey rather than skipping it.** `journeys learn` exits
 * 75 when another checkout is recording; the first version logged a 1s
 * row and moved on, and six rows that looked like measurements appeared. A held
 * journey is retried; one held too long ends the sweep and says so.
 *
 * **The delta runs once, for the batch**, with its verdict applied here: each
 * learn runs with `--defer-delta`, because the report diffs the whole tree and
 * per-journey it was 22 minutes of a 69-minute sweep.
 *
 * Writes `<reportRoot>/timing.md` and `timing.json` — measurements of one
 * machine at one moment, which is why they are not committed: committed, a
 * timing reads as a budget.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import { recordedPaths } from "../evidence-tree.mts";
import { readRunJson } from "../recorder/evidence.mts";
import { loadCeiling } from "../stack/load-gate.mts";
import { DELTA_CLI, LEARN_CLI } from "./paths.mts";

const HELD = 75;
const HOLD_LIMIT_MS = 45 * 60_000;
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function quiet(ceiling: number): Promise<number> {
  let said = false;
  for (;;) {
    const load = loadavg()[0] ?? 0;
    if (load < ceiling) return load;
    if (!said) {
      console.log(
        `  waiting for the machine to go quiet — load ${load.toFixed(2)}, need < ${ceiling}`,
      );
      said = true;
    }
    await wait(15_000);
  }
}

async function main(): Promise<number> {
  const root = journeysRoot();
  const config = await loadJourneysConfig(root);
  const argv = process.argv.slice(2);
  const dwellAt = argv.indexOf("--dwell");
  const dwell = dwellAt >= 0 ? argv[dwellAt + 1] : undefined;
  // A flag's value index exists only when the flag does: -1 + 1 is 0, which
  // once silently dropped the first journey id.
  const valueAt = dwellAt >= 0 ? dwellAt + 1 : -1;
  const only = argv
    .filter((a, i) => !a.startsWith("--") && i !== valueAt)
    .map((a) => a.toUpperCase());
  const relearn = argv.includes("--relearn");

  const byId = new Map<string, { id: string; paths: number; steps: number }>();
  for (const rec of recordedPaths(join(root, config.evidenceRoot))) {
    const row = byId.get(rec.id) ?? { id: rec.id, paths: 0, steps: 0 };
    row.paths += 1;
    row.steps += readRunJson(join(rec.dir, "run.json"))?.steps ?? 0;
    byId.set(rec.id, row);
  }
  const list = [...byId.values()]
    .filter((j) => only.length === 0 || only.includes(j.id))
    .sort((a, b) => b.steps - a.steps);
  if (list.length === 0) {
    console.error(`No recorded journey matched ${only.join(", ") || "(anything)"}.`);
    return 1;
  }

  const ceiling = loadCeiling(cpus().length);
  const label =
    (dwell ? `JOURNEY_DWELL=${dwell}` : "default settings") + (relearn ? " · --relearn" : "");
  console.log(`\nTiming ${list.length} journey(s), one at a time, under ${label}.\n`);

  const rows: Array<{
    id: string;
    paths: number;
    steps: number;
    seconds: number;
    startLoad: number;
    exit: number;
  }> = [];
  for (const journey of list) {
    let exit = HELD;
    let seconds = 0;
    let startLoad = 0;
    const since = Date.now();
    while (exit === HELD) {
      startLoad = await quiet(ceiling);
      const t0 = Date.now();
      exit =
        spawnSync(
          process.execPath,
          [LEARN_CLI, "--journey", journey.id, ...(relearn ? ["--relearn"] : []), "--defer-delta"],
          {
            cwd: root,
            stdio: "inherit",
            env: dwell ? { ...process.env, JOURNEY_DWELL: dwell } : process.env,
          },
        ).status ?? 1;
      seconds = Math.round((Date.now() - t0) / 1000);
      if (exit !== HELD) break;
      if (Date.now() - since > HOLD_LIMIT_MS) {
        console.error(
          `\n✗ ${journey.id} has been held for over ${HOLD_LIMIT_MS / 60_000} minutes. Nothing was recorded; ` +
            `${rows.length} journey(s) completed before it.\n`,
        );
        return 1;
      }
      console.log(`\n  ${journey.id} held — retrying in 60s (nothing was recorded).\n`);
      await wait(60_000);
    }
    rows.push({ ...journey, seconds, startLoad, exit });
    console.log(
      `\n▸ ${journey.id} ${exit === 0 ? "green" : `EXIT ${exit}`} — ${seconds}s (${journey.steps} steps)\n`,
    );
  }

  const deltaExit =
    spawnSync(process.execPath, [DELTA_CLI, "--report"], { cwd: root, stdio: "inherit" }).status ??
    1;
  if (deltaExit !== 0) {
    console.error(
      "\n✗ The delta report refuses this sweep — a spurious mask, or a step that did not hold. Read " +
        `${config.reportRoot}/delta.md before committing any of these recordings.\n`,
    );
  }

  const total = rows.reduce((n, r) => n + r.seconds, 0);
  const steps = rows.reduce((n, r) => n + r.steps, 0);
  const red = rows.filter((r) => r.exit !== 0);
  let head = "unknown";
  try {
    head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    // Not a repository: the report says so rather than inventing a revision.
  }
  const stamp = new Date().toISOString();
  const md = [
    "# Journey recording time",
    "",
    `**${label}** · ${rows.length} journeys · ${steps} steps · \`${head}\` · ${stamp}`,
    "",
    "> Written by `journeys timing`. Not committed: a timing is one machine at one moment.",
    "",
    `**Total ${total}s (${(total / 60).toFixed(1)} min)**` +
      (red.length
        ? ` — **${red.length} journey(s) did not pass**; their times are the cost of a failure.`
        : ""),
    "",
    "| journey | steps | paths | seconds | s/step | start load | |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.steps} | ${r.paths} | ${r.seconds} | ${r.steps ? (r.seconds / r.steps).toFixed(1) : "—"} | ` +
        `${r.startLoad.toFixed(2)} | ${r.exit === 0 ? "green" : `**exit ${r.exit}**`} |`,
    ),
    "",
    "`s/step` is the comparable column: a long journey looking slow is arithmetic. Each journey also",
    "pays the stack once — build, start, seed — which dominates a short one.",
    "",
  ].join("\n");
  const dir = join(root, config.reportRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "timing.md"), md);
  writeFileSync(
    join(dir, "timing.json"),
    JSON.stringify({ label, head, stamp, dwell: dwell ?? null, total, steps, rows }, null, 2),
  );
  console.log(
    `\n${relative(root, join(dir, "timing.md"))} — ${total}s across ${rows.length} journeys`,
  );
  return red.length > 0 || deltaExit !== 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
