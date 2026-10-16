/**
 * **The state of every journey recording, read from disk, rendered as pages.**
 *
 * `<evidence>/README.md` is an index of **what is recorded and what QA can pick
 * up**, generated after every run. It lists the journeys with no recording too:
 * only an index of what is *missing* answers "what have we not done", which is
 * the question somebody planning the next fortnight is asking.
 *
 * ## Three states, derived and never declared
 *
 * | | means | QA |
 * | --- | --- | --- |
 * | **ready for QA** | every recorded path green **and** a person signed it off | pick these up |
 * | **in dev testing** | recorded, and something does not pass or nobody released it | not yet |
 * | **not started** | in the registry, nothing recorded | not yet |
 *
 * Green says the paths that exist pass; it cannot say the right paths were
 * written. So a journey reaches QA only by a person's line in
 * `ready-for-qa.md`, and **a sign-off does not override red** — a released
 * journey that goes red comes straight back.
 *
 * ## The journey's own page is a pointer, written from disk
 *
 * Every walk's real page is `<journey>/<persona>/README.md` (`journey-page.mts`).
 * `<journey>/README.md` above it lists the walks. Derived from disk, two
 * personas recorded on two branches merge as two directories and the pointer is
 * regenerated — never a prose conflict nobody can resolve without picking a
 * winner. **Never hand-merge a generated table; re-run.**
 *
 * ## The status line is republished without a browser
 *
 * A sign-off changes no recording, so publishing one must not need a re-record
 * — a re-run can fail on unrelated visual drift and block a release for a
 * reason that has nothing to do with the decision. `withStatusLine` rewrites
 * the one line, from the same helper the recorder uses.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { journeyFolders, idOf, personaDirs, recordedPaths } from "../evidence-tree.mts";
import { duration, GENERATED, pathIsGreen, readRunJson, stepCount } from "../recorder/evidence.mts";
import { COMMON, journeyFolder } from "../registry.mts";
import type { Registry } from "../registry.mts";
import { journeyStatusLine, signedOffIds, withStatusLine } from "../verdict.mts";

export type IndexedPath = {
  path: string;
  persona?: { key: string; label: string };
  steps: number;
  ms: number | null;
  green: boolean;
  recordedAt: string | null;
};

export type IndexedJourney = {
  id: string;
  folder: string;
  title: string | null;
  paths: IndexedPath[];
};

export type IndexState = {
  recorded: IndexedJourney[];
  ready: IndexedJourney[];
  testing: IndexedJourney[];
  notStarted: Array<{ id: string; title: string }>;
  /** Folders whose id the registry does not declare — a renamed or deleted journey. */
  undeclared: string[];
  signedOff: Set<string>;
};

export function readIndex(
  evidenceRoot: string,
  registry: Registry,
  { idPrefixes = [] }: { idPrefixes?: readonly string[] } = {},
): IndexState {
  const register = join(evidenceRoot, "ready-for-qa.md");
  const signedOff = signedOffIds(existsSync(register) ? readFileSync(register, "utf8") : "", {
    prefixes: idPrefixes,
  });

  const byFolder = new Map<string, IndexedPath[]>();
  for (const rec of recordedPaths(evidenceRoot)) {
    const readme = join(rec.dir, "README.md");
    if (!existsSync(readme)) continue;
    const narrative = readFileSync(readme, "utf8");
    const run = readRunJson(join(rec.dir, "run.json"));
    const marker = rec.persona
      ? personaDirs(join(evidenceRoot, rec.journeyFolder)).find((p) => p.dir === rec.persona)
      : undefined;
    const list = byFolder.get(rec.journeyFolder) ?? [];
    list.push({
      path: rec.persona ? `${rec.persona}/${rec.path}` : rec.path,
      ...(marker ? { persona: { key: marker.key, label: marker.label } } : {}),
      steps: stepCount(narrative),
      // Absent is null, never 0: a zero reads as instant.
      ms: typeof run?.ms === "number" ? run.ms : null,
      green: pathIsGreen(narrative),
      recordedAt: typeof run?.recordedAt === "string" ? run.recordedAt : null,
    });
    byFolder.set(rec.journeyFolder, list);
  }

  const recorded: IndexedJourney[] = [...byFolder.entries()].map(([folder, paths]) => {
    const id = idOf(folder);
    return {
      id,
      folder,
      title: registry.journeys.find((j) => j.id === id)?.title ?? null,
      paths: paths.sort((a, b) => a.path.localeCompare(b.path)),
    };
  });
  const ready = recorded.filter((r) => r.paths.every((p) => p.green) && signedOff.has(r.id));
  const testing = recorded.filter((r) => !ready.includes(r));
  const recordedIds = new Set(recorded.map((r) => r.id));
  return {
    recorded,
    ready,
    testing,
    notStarted: registry.journeys
      .filter((j) => !recordedIds.has(j.id))
      .map((j) => ({ id: j.id, title: j.title })),
    undeclared: journeyFolders(evidenceRoot).filter(
      (f) => !registry.journeys.some((j) => journeyFolder(j.id, j.title) === f),
    ),
    signedOff,
  };
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id.localeCompare(b.id, undefined, { numeric: true });

function table(group: readonly IndexedJourney[]): string[] {
  if (group.length === 0) return ["_None._", ""];
  const rows = ["| journey | path | steps | took |", "| --- | --- | ---: | ---: |"];
  for (const r of [...group].sort(byId)) {
    r.paths.forEach((p, i) => {
      const name = r.title ? `${r.id} ${r.title}` : r.id;
      rows.push(
        `| ${i === 0 ? `[${name}](${r.folder}/README.md)` : ""} | [${p.path}](${r.folder}/${p.path}/README.md)` +
          `${p.green ? "" : " ⚠"} | ${p.steps} | ${p.ms === null ? "—" : duration(p.ms)} |`,
      );
    });
  }
  return [...rows, ""];
}

export function renderIndex(state: IndexState, declared: number): string {
  const totalPaths = state.recorded.reduce((n, r) => n + r.paths.length, 0);
  const totalSteps = state.recorded.reduce(
    (n, r) => n + r.paths.reduce((m, p) => m + p.steps, 0),
    0,
  );
  const stamps = state.recorded
    .flatMap((r) => r.paths.map((p) => p.recordedAt))
    .filter((d): d is string => d !== null)
    .sort();
  const unstamped = totalPaths - stamps.length;
  const day = (iso: string) => iso.slice(0, 10);
  // The undated paths lead: a summary that opens with its freshest data and
  // buries the unknown reads as a fact about the whole corpus.
  const freshness =
    totalPaths === 0
      ? "Nothing is recorded yet."
      : stamps.length === 0
        ? `No path carries a recording date, so the age of all ${totalPaths} is unknown.`
        : unstamped > 0
          ? `${unstamped} of ${totalPaths} paths carry no recording date and their age is unknown; the rest were recorded ${day(stamps[0]!)} to ${day(stamps.at(-1)!)}.`
          : `Every path recorded ${day(stamps[0]!) === day(stamps.at(-1)!) ? day(stamps[0]!) : `${day(stamps[0]!)} to ${day(stamps.at(-1)!)}`}.`;

  const walkers = new Map<string, { journeys: Set<string>; paths: number; steps: number }>();
  for (const r of state.recorded) {
    for (const p of r.paths) {
      const key = p.persona?.key ?? "(no persona level)";
      const row = walkers.get(key) ?? { journeys: new Set<string>(), paths: 0, steps: 0 };
      row.journeys.add(r.id);
      row.paths += 1;
      row.steps += p.steps;
      walkers.set(key, row);
    }
  }

  return [
    "# Journey recordings — what is recorded, and what QA can pick up",
    "",
    GENERATED,
    "> Regenerated by `journeys index` after every run. The procedure for recording",
    "> one is `/journeys test`; for releasing one, `/journeys ready-for-qa`.",
    "",
    `**${state.ready.length} of ${declared} journeys ready for QA** — ${state.testing.length} in dev testing, ` +
      `${state.notStarted.length} not started. ${totalPaths} paths, ${totalSteps} interactions.`,
    "",
    freshness,
    "",
    "## By walk",
    "",
    "Whose walk the recorded evidence is. `common` is the part that depends on nobody.",
    "",
    "| walk | journeys | paths | interactions |",
    "| --- | ---: | ---: | ---: |",
    ...[...walkers.entries()]
      .sort((a, b) => b[1].paths - a[1].paths || a[0].localeCompare(b[0]))
      .map(([key, row]) => `| \`${key}\` | ${row.journeys.size} | ${row.paths} | ${row.steps} |`),
    "",
    "## Ready for QA",
    "",
    "Green, **and** released in [ready-for-qa.md](ready-for-qa.md). This is what QA picks up.",
    "",
    ...table(state.ready),
    "## In dev testing",
    "",
    "Not QA's yet: `⚠` marks a path that does not pass — the folder is then a diagnosis rather than",
    "evidence — or nobody has released the journey in [ready-for-qa.md](ready-for-qa.md).",
    "",
    ...table(state.testing),
    "## Not started",
    "",
    ...(state.notStarted.length
      ? [...state.notStarted].sort(byId).map((j) => `- ${j.id} ${j.title}`)
      : ["_None._"]),
    "",
    ...(state.undeclared.length
      ? [
          "## Recorded, and in no registry",
          "",
          "A folder whose journey the registry does not declare at that title — usually a rename that",
          "left the old recording behind, which every disk-derived page would otherwise report as current.",
          "",
          ...state.undeclared.map((f) => `- \`${f}\``),
          "",
        ]
      : []),
  ].join("\n");
}

/** `<journey>/README.md`: one row per persona's walk, with the verdict for the whole. */
export function renderPointer(journey: IndexedJourney, signedOff: boolean): string {
  const personas = [
    ...new Map(
      journey.paths.filter((p) => p.persona).map((p) => [p.persona!.key, p.persona!]),
    ).values(),
  ].sort((a, b) => (a.key === COMMON ? -1 : b.key === COMMON ? 1 : a.key.localeCompare(b.key)));
  return [
    `# ${journey.title ? `${journey.id} ${journey.title}` : journey.id}`,
    "",
    GENERATED,
    "> One row per recorded walk. Where a row names somebody, the walk is theirs; `common` is the",
    "> part that does not depend on who performs it. The evidence lives one folder down.",
    "",
    journeyStatusLine({
      failingPaths: journey.paths.filter((p) => !p.green).map((p) => p.path),
      totalPaths: journey.paths.length,
      signedOff,
    }),
    "",
    "| walk | paths | recorded | |",
    "| --- | ---: | --- | --- |",
    ...personas.map((persona) => {
      const walked = journey.paths.filter((p) => p.persona?.key === persona.key);
      const dates = walked
        .map((p) => p.recordedAt)
        .filter((d): d is string => d !== null)
        .sort();
      const red = walked.filter((p) => !p.green).length;
      return (
        `| **${persona.label}** | ${walked.length}${red ? ` · ${red} red` : ""} ` +
        `| ${dates.length ? dates.at(-1)!.slice(0, 10) : "—"} | [read the walk](${persona.key}/README.md) |`
      );
    }),
    "",
    "A persona whose row is missing has not been walked — a gap in the evidence, not a claim",
    "that the journey does not apply to them.",
    "",
  ].join("\n");
}

/**
 * A persona page with its status line republished, or the page unchanged — and
 * whether it had a line at all. A page with none is left alone and reported: an
 * unrecognised page is a finding, not something to repair by inserting a line
 * into a file this does not understand.
 */
export function republish(
  page: string,
  {
    failingPaths,
    totalPaths,
    signedOff,
  }: { failingPaths: string[]; totalPaths: number; signedOff: boolean },
): { page: string; recognised: boolean } {
  const recognised = /^\*\*(In Dev Testing|Dev Tested)/m.test(page);
  return {
    page: withStatusLine(
      page,
      journeyStatusLine({ failingPaths, totalPaths, signedOff, register: "../../ready-for-qa.md" }),
    ),
    recognised,
  };
}
