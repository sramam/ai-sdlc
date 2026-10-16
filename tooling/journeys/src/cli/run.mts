/**
 * `journeys test` — one comparison pass: every step against the committed
 * reference, under the committed mask. It never learns, never writes a mask and
 * never updates a reference; **only recording does**, and a recording is
 * reviewed in a pull request like code.
 *
 * ```
 * journeys test                                  every journey
 * journeys test --journey J4                     all of J4's walks
 * journeys test --journey J4 --persona common    one walk
 * journeys test --grep "…"                       Playwright's own, untouched
 * ```
 */
import { pathToFileURL } from "node:url";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import { runPlaywright } from "./playwright-run.mts";
import { selectSpecs } from "./select.mts";

async function main(): Promise<number> {
  const root = journeysRoot();
  const config = await loadJourneysConfig(root);
  let selection;
  try {
    selection = selectSpecs(process.argv.slice(2), root, config.specDir);
  } catch (error) {
    console.error(`\n${(error as Error).message}\n`);
    return 1;
  }
  const { files, rest, asked } = selection;
  if (asked.journey || asked.persona) {
    console.warn(
      `\n▸ ${[asked.journey, asked.persona].filter(Boolean).join(" · ")} — ${files.length} spec(s):`,
    );
    for (const f of files) console.warn(`    ${f}`);
    console.warn("");
  }
  // A comparison run must not inherit a learning flag from the shell.
  const env = { ...process.env };
  for (const name of ["JOURNEY_MASKS", "JOURNEY_MASK_RECORD", "JOURNEY_RELEARN"]) delete env[name];
  return runPlaywright(root, config.playwrightConfig, [...files, ...rest], env);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
