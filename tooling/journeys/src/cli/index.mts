/**
 * `journeys index` — rewrite the evidence index, every journey's pointer page,
 * and every walk's status line, from what is on disk. No browser, no stack,
 * seconds. Run by the Playwright teardown after every run, and by
 * `/journey-ready-for-qa` to publish a sign-off. See `index/index-lib.mts`.
 *
 * **It writes only what is derived**: no run duration goes into a committed
 * page (that is a property of a run, and a gate over a generated file needs a
 * deterministic generator), so the wall clock is printed instead.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import { readIndex, renderIndex, renderPointer, republish } from "../index/index-lib.mts";
import { duration } from "../recorder/evidence.mts";
import { RUN_STAMP } from "../playwright/run-stamp.mts";

async function main(): Promise<number> {
  const root = journeysRoot();
  const config = await loadJourneysConfig(root);
  const evidence = join(root, config.evidenceRoot);
  if (!existsSync(evidence)) {
    console.warn(
      `journeys index — ${config.evidenceRoot}/ does not exist yet; nothing is recorded.`,
    );
    return 0;
  }
  const state = readIndex(evidence, config.registry, { idPrefixes: config.idPrefixes });
  writeFileSync(join(evidence, "README.md"), renderIndex(state, config.registry.journeys.length));

  const republished: string[] = [];
  const unrecognised: string[] = [];
  for (const journey of state.recorded) {
    const signedOff = state.signedOff.has(journey.id);
    const personas = new Set(
      journey.paths.map((p) => p.persona?.key).filter((k): k is string => !!k),
    );
    if (personas.size > 0)
      writeFileSync(join(evidence, journey.folder, "README.md"), renderPointer(journey, signedOff));
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
        writeFileSync(file, page);
        republished.push(`${journey.id}/${key}`);
      }
    }
  }

  // Consumed on read: a hand run hours later must not report the gap as a duration.
  const stamp = join(root, config.scratchRoot, RUN_STAMP);
  let wall: number | null = null;
  if (existsSync(stamp)) {
    const { startedAt } = JSON.parse(readFileSync(stamp, "utf8")) as { startedAt?: number };
    rmSync(stamp, { force: true });
    if (typeof startedAt === "number") wall = Date.now() - startedAt;
  }

  if (republished.length) console.warn(`  status republished: ${republished.join(", ")}`);
  if (unrecognised.length)
    console.warn(`  no status line to update, so left alone: ${unrecognised.join(", ")}`);
  if (state.undeclared.length)
    console.warn(`  recorded and in no registry: ${state.undeclared.join(", ")}`);
  console.warn(
    `${config.evidenceRoot}/README.md — ${state.ready.length} ready for QA, ${state.testing.length} in dev testing, ` +
      `${state.notStarted.length} not started${wall === null ? "" : ` · run ${duration(wall)}`}`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
