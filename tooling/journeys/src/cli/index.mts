/**
 * `journeys index` — rewrite the evidence index, every journey's pointer page,
 * and every walk's status line, from what is on disk. No browser, no stack,
 * seconds. Run by the Playwright teardown after every run, and by
 * `/journeys ready-for-qa` to publish a sign-off. See `index/index-lib.mts`.
 *
 * ```
 * journeys index            write what is derived
 * journeys index --check    write nothing; exit 1 if any generated page differs
 * ```
 *
 * **It writes only what is derived**: no run duration goes into a committed
 * page (that is a property of a run, and a gate over a generated file needs a
 * deterministic generator), so the wall clock is printed instead. That is what
 * makes `--check` a gate: the same evidence always renders the same pages, so a
 * difference is a page somebody edited by hand or forgot to regenerate.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import { readIndex, renderIndex, renderPointer, republish } from "../index/index-lib.mts";
import { duration } from "../recorder/evidence.mts";
import { RUN_STAMP } from "../playwright/run-stamp.mts";

type Plan = {
  /** Every generated page, with what it should hold. */
  pages: Array<{ file: string; content: string }>;
  republished: string[];
  unrecognised: string[];
  undeclared: string[];
  summary: string;
};

/** What the index would write, computed without writing anything. */
function plan(evidence: string, config: Awaited<ReturnType<typeof loadJourneysConfig>>): Plan {
  const state = readIndex(evidence, config.registry, { idPrefixes: config.idPrefixes });
  const pages: Plan["pages"] = [
    {
      file: join(evidence, "README.md"),
      content: renderIndex(state, config.registry.journeys.length),
    },
  ];
  const republished: string[] = [];
  const unrecognised: string[] = [];
  for (const journey of state.recorded) {
    const signedOff = state.signedOff.has(journey.id);
    const personas = new Set(
      journey.paths.map((p) => p.persona?.key).filter((k): k is string => !!k),
    );
    if (personas.size > 0)
      pages.push({
        file: join(evidence, journey.folder, "README.md"),
        content: renderPointer(journey, signedOff),
      });
    for (const key of personas) {
      const file = join(evidence, journey.folder, key, "README.md");
      if (!existsSync(file)) continue;
      const walked = journey.paths.filter((p) => p.persona?.key === key);
      const before = readFileSync(file, "utf8");
      const { page, recognised } = republish(before, {
        failingPaths: walked.filter((p) => !p.green).map((p) => p.path.slice(key.length + 1)),
        totalPaths: walked.length,
        signedOff,
      });
      if (!recognised) unrecognised.push(`${journey.id}/${key}`);
      else if (page !== before) {
        pages.push({ file, content: page });
        republished.push(`${journey.id}/${key}`);
      }
    }
  }
  return {
    pages,
    republished,
    unrecognised,
    undeclared: state.undeclared,
    summary:
      `${state.ready.length} ready for QA, ${state.testing.length} in dev testing, ` +
      `${state.notStarted.length} not started`,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const check = argv.includes("--check");
  const unknown = argv.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    console.error(
      `journeys index: unknown argument ${unknown.join(" ")} — usage: journeys index [--check]`,
    );
    return 2;
  }
  const root = journeysRoot();
  const config = await loadJourneysConfig(root);
  const evidence = join(root, config.evidenceRoot);
  if (!existsSync(evidence)) {
    console.warn(
      `journeys index — ${config.evidenceRoot}/ does not exist yet; nothing is recorded${check ? ", so nothing can drift" : ""}.`,
    );
    return 0;
  }
  const planned = plan(evidence, config);

  if (check) {
    // Nothing is written and the run stamp is not consumed: a check is read-only.
    const drifted = planned.pages.filter(
      ({ file, content }) => !existsSync(file) || readFileSync(file, "utf8") !== content,
    );
    for (const { file } of planned.pages) {
      const bad = drifted.some((d) => d.file === file);
      console.warn(`  ${bad ? "DRIFT" : "ok   "} ${relative(root, file)}`);
    }
    if (drifted.length > 0) {
      console.error(
        `\n✗ journeys index --check: ${drifted.length} generated page(s) differ from what the evidence renders.\n` +
          "  Regenerate with `pnpm journeys:index` and commit the result; never hand-edit a generated page.",
      );
      return 1;
    }
    console.warn(
      `journeys index --check — ${planned.pages.length} generated page(s) match the evidence (${planned.summary}).`,
    );
    return 0;
  }

  for (const { file, content } of planned.pages) writeFileSync(file, content);

  // Consumed on read: a hand run hours later must not report the gap as a duration.
  const stamp = join(root, config.scratchRoot, RUN_STAMP);
  let wall: number | null = null;
  if (existsSync(stamp)) {
    const { startedAt } = JSON.parse(readFileSync(stamp, "utf8")) as { startedAt?: number };
    rmSync(stamp, { force: true });
    if (typeof startedAt === "number") wall = Date.now() - startedAt;
  }

  if (planned.republished.length)
    console.warn(`  status republished: ${planned.republished.join(", ")}`);
  if (planned.unrecognised.length)
    console.warn(`  no status line to update, so left alone: ${planned.unrecognised.join(", ")}`);
  if (planned.undeclared.length)
    console.warn(`  recorded and in no registry: ${planned.undeclared.join(", ")}`);
  console.warn(
    `${config.evidenceRoot}/README.md — ${planned.summary}${wall === null ? "" : ` · run ${duration(wall)}`}`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
