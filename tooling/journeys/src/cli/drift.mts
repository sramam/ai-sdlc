/**
 * `journeys drift` — which journeys photograph a screen this branch changed.
 *
 * ```
 * journeys drift                 against driftBase (origin/dev)
 * journeys drift --base <ref>
 * ```
 *
 * Exits 1 when a journey photographs a changed route and was neither
 * re-recorded nor excused by a `No-Rerecord: J<n> <reason>` commit trailer in
 * the range. The reasoning is in `drift/drift.mts`. Prints on success too: a
 * check whose normal output is silence cannot be told from one that never ran.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import {
  TRAILER,
  changedFiles,
  drift,
  parseExcuses,
  recordings,
  trailerValues,
} from "../drift/drift.mts";
import { loadRouteAdapter } from "../routes/load.mts";

async function main(): Promise<number> {
  const root = journeysRoot();
  const config = await loadJourneysConfig(root);
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--base");
  const base = at >= 0 ? (argv[at + 1] ?? config.driftBase) : config.driftBase;

  const routes = await loadRouteAdapter(config.routes, root);
  const changed = changedFiles(root, base);
  const found = drift(
    changed,
    recordings(join(root, config.evidenceRoot)),
    routes,
    config.evidenceRoot,
  );
  const { excused, refused } = parseExcuses(trailerValues(root, base));
  const excusedIds = new Set(excused.map((e) => e.id));
  const owed = found.filter((d) => !excusedIds.has(d.id));

  for (const r of refused) {
    console.log(
      `journeys drift — ignoring \`${TRAILER}: ${r}\`: it needs a journey id and a reason.`,
    );
  }
  for (const e of excused.filter((x) => found.some((d) => d.id === x.id))) {
    console.log(`journeys drift — ${e.id} excused: ${e.reason}`);
  }

  if (owed.length === 0) {
    const touched = changed.filter((f) => routes.routeOf(f) !== null).length;
    console.log(
      touched === 0
        ? `journeys drift — no rendered route (${routes.name}) changed against ${base}. Nothing to re-record.`
        : `journeys drift — ${touched} route file(s) changed against ${base}; every journey that photographs ` +
            "them was re-recorded here or excused.",
    );
    return 0;
  }

  console.log(
    `\njourneys drift — ${owed.length} journey(s) photograph a screen this branch changed\n`,
  );
  for (const d of owed) {
    console.log(`  ${d.journey}`);
    console.log(`      routes   ${d.routes.join(", ")}`);
    console.log(
      `      changed  ${d.changedFiles.slice(0, 3).join(", ")}${d.changedFiles.length > 3 ? ` (+${d.changedFiles.length - 3})` : ""}`,
    );
  }
  console.log(
    "\n  Re-record each, or excuse it with a trailer on a commit in this range:\n" +
      "      journeys learn --journey <id> --persona <persona>\n" +
      `      ${TRAILER}: <id> <reason>\n\n` +
      "  This says where to look, not that pixels moved — and it is blind to shared\n" +
      "  components, which have no route. Nothing reported is not proof that nothing moved.\n",
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
