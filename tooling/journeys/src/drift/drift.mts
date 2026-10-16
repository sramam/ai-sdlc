/**
 * **Which journeys photograph a route this branch changed — and were not
 * re-recorded, and were not excused.**
 *
 * The journey suite needs a browser and a stack, so it is not in every CI run,
 * and a merge can change a screen whose only signal is somebody re-recording
 * later and finding a red comparison they did not cause. It has happened three
 * times, each a careful change by a careful author. Gating the full suite costs
 * a minute per journey per pull request; a convention is the thing that already
 * failed. This asks the cheap half: **which recordings visited the route a
 * changed file renders** — statically, in about a second.
 *
 * It reads what the journeys *did* (`run.json`'s `visited`, observed in the
 * browser), not what their specs say — so a page reached by clicking a link
 * counts, which grepping `goto("…")` would miss.
 *
 * ## Satisfiable two ways, so it is not routed around
 *
 * - **re-record the journey** in the same range — any file under its folder changed
 * - **excuse it with a commit trailer** on a commit in the range:
 *
 *   ```
 *   No-Rerecord: J4 the change is copy in a tooltip no step opens
 *   ```
 *
 *   A trailer rather than a pull-request-body line: it travels with the
 *   commit, survives a merge commit, and `git interpret-trailers` reads it — a
 *   body that merely *quotes* one in prose is not a trailer. One journey per
 *   trailer, and **a reason is required**: an excuse with no reason is a gate
 *   nobody had to think about.
 *
 * ## What it cannot see
 *
 * A shared component has no route (`routes/adapter.mts`). **Nothing reported is
 * not proof that nothing moved.**
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { recordedPaths } from "../evidence-tree.mts";
import { readRunJson } from "../recorder/evidence.mts";
import { under } from "../routes/adapter.mts";
import type { RouteAdapter } from "../routes/adapter.mts";

export const TRAILER = "No-Rerecord";

export type Recording = { journey: string; id: string; visited: string[] };

export type Drift = { journey: string; id: string; routes: string[]; changedFiles: string[] };

export type Excuse = { id: string; reason: string };

/** Every recorded path's visited routes, keyed by journey folder. */
export function recordings(evidenceRoot: string): Recording[] {
  return recordedPaths(evidenceRoot).map((rec) => ({
    journey: rec.journeyFolder,
    id: rec.id,
    visited: readRunJson(join(rec.dir, "run.json"))?.visited ?? [],
  }));
}

/**
 * `No-Rerecord` trailer values, one per line as git prints them. A value is
 * `<id> <reason>`; one with no reason is returned in `refused` — it is the
 * excuse that never had to be thought about.
 */
export function parseExcuses(values: string): { excused: Excuse[]; refused: string[] } {
  const excused: Excuse[] = [];
  const refused: string[] = [];
  for (const raw of values
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const m = /^([A-Za-z]+\d+)\s+(.+)$/.exec(raw);
    if (m) excused.push({ id: m[1]!.toUpperCase(), reason: m[2]!.trim() });
    else refused.push(raw);
  }
  return { excused, refused };
}

/** The `No-Rerecord` trailer values on every commit in `base..HEAD`. */
export function trailerValues(root: string, base: string): string {
  return execFileSync(
    "git",
    ["log", `--format=%(trailers:key=${TRAILER},valueonly)`, `${base}..HEAD`],
    { cwd: root, encoding: "utf8" },
  );
}

/** Files changed in `base...HEAD`, repository-relative. */
export function changedFiles(root: string, base: string): string[] {
  return execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

/**
 * The finding: journeys whose recordings visited a route a changed file
 * renders, whose own evidence did not change in the same range.
 */
export function drift(
  changed: readonly string[],
  recs: readonly Recording[],
  routes: RouteAdapter,
  evidenceRoot: string,
): Drift[] {
  const touched = new Map<string, string[]>();
  for (const f of changed) {
    const r = routes.routeOf(f);
    if (r !== null) touched.set(r, [...(touched.get(r) ?? []), f]);
  }
  if (touched.size === 0) return [];

  const prefix = `${evidenceRoot.replace(/\/$/, "")}/`;
  const rerecorded = new Set(
    changed.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split("/")[0]!),
  );

  const hits = new Map<string, { id: string; routes: Set<string>; files: Set<string> }>();
  for (const rec of recs) {
    if (rerecorded.has(rec.journey)) continue;
    for (const [pattern, files] of touched) {
      if (!rec.visited.some((v) => under(pattern, v))) continue;
      const e = hits.get(rec.journey) ?? {
        id: rec.id,
        routes: new Set<string>(),
        files: new Set<string>(),
      };
      e.routes.add(pattern);
      for (const f of files) e.files.add(f);
      hits.set(rec.journey, e);
    }
  }
  return [...hits]
    .map(([journey, e]) => ({
      journey,
      id: e.id,
      routes: [...e.routes].sort(),
      changedFiles: [...e.files].sort(),
    }))
    .sort((a, b) => a.journey.localeCompare(b.journey));
}
