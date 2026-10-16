/**
 * **The pattern checks a project runs over its own journeys**, as functions that
 * return findings — so a project's test file is a few lines and the logic, with
 * its reasons, lives here once.
 *
 * ```ts
 * // e2e/journeys.pattern-check.test.ts (vitest)
 * import { loadJourneysConfig } from "../tooling/journeys/src/config.mts";
 * import { journeyPatternCheck } from "../tooling/journeys/src/pattern-check/pattern-check.mts";
 * const report = journeyPatternCheck(root, await loadJourneysConfig(root));
 * for (const [name, c] of Object.entries(report)) it(name, () => expect(c.findings).toEqual([]));
 * ```
 *
 * Each has the shape every pattern check here shares, because the shape is what keeps
 * one honest: **enumerate from the source, check against it, report what was
 * checked** (`checked` — a pattern check satisfied by finding nothing at all must show
 * it found something to check), and **ratchet in both directions** — a known
 * exception that no longer applies is itself a finding, so a gap list cannot
 * outlive its gap.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JourneysConfig } from "../config.mts";
import { idOf, journeyFolders, personaDirs, recordedPaths } from "../evidence-tree.mts";
import { readPersonaMarker } from "../recorder/evidence.mts";
import { COMMON, journeyFolder } from "../registry.mts";
import type { Registry } from "../registry.mts";
import { parseSpecName } from "../cli/select.mts";

export type PatternCheck = { checked: number; findings: string[] };

/**
 * **Every screenshot in a recording is named by its narrative**, and every
 * name resolves (#1403).
 *
 * Renaming or inserting a step leaves the old image behind; the run stays
 * green, every link resolves, and `git status` shows additions with no
 * deletions — which is what correct work looks like too. A step counts as live
 * when its screenshot **or** its mask overlay is named, because `README.md`
 * embeds one and `diff.md` the other. Masks are never what trips it: an
 * orphan's mask siblings are listed beside it.
 */
export function snapshotPatternCheck(
  evidenceRoot: string,
  { knownOrphans = [] }: { knownOrphans?: readonly string[] } = {},
): PatternCheck {
  const findings: string[] = [];
  const orphans = new Set<string>();
  let checked = 0;
  for (const rec of recordedPaths(evidenceRoot)) {
    const shots = join(rec.dir, "snapshots");
    if (!existsSync(shots)) continue;
    const files = readdirSync(shots).filter((f) => !statSync(join(shots, f)).isDirectory());
    let text = "";
    for (const doc of ["README.md", "diff.md"]) {
      if (existsSync(join(rec.dir, doc))) text += readFileSync(join(rec.dir, doc), "utf8");
    }
    const named = new Set(
      [...text.matchAll(/snapshots\/([A-Za-z0-9._-]+\.png)/g)].map((m) => m[1]!),
    );
    const live = new Set(
      [...named].map((n) =>
        n.endsWith("-mask.png") ? `${n.slice(0, -"-mask.png".length)}.png` : n,
      ),
    );
    for (const f of files.filter((f) => f.endsWith(".png") && !f.endsWith("-mask.png")).sort()) {
      checked++;
      if (live.has(f)) continue;
      const id = `${rec.rel}/${f}`;
      orphans.add(id);
      if (knownOrphans.includes(id)) continue;
      const also = [`${f.slice(0, -".png".length)}-mask.png`, `${f}.mask.json`].filter((s) =>
        files.includes(s),
      );
      findings.push(`orphan screenshot ${id}${also.length ? ` (also: ${also.join(", ")})` : ""}`);
    }
    for (const n of [...named].sort())
      if (!files.includes(n)) findings.push(`${rec.rel}: names ${n}, which is not on disk`);
    for (const f of files.filter((f) => f.endsWith(".png.mask.json"))) {
      if (!files.includes(f.slice(0, -".mask.json".length)))
        findings.push(`${rec.rel}: mask ${f} has no screenshot`);
    }
  }
  for (const k of knownOrphans)
    if (!orphans.has(k))
      findings.push(`knownOrphans names ${k}, which is no longer an orphan — delete the line`);
  return { checked, findings };
}

/**
 * **Every evidence folder belongs to a registered journey at its current title**
 * (#1240). A renamed journey writes a new folder and leaves the old
 * one holding a complete, plausible, stale set of screenshots that every
 * disk-derived page reports as current.
 */
export function directoryPatternCheck(evidenceRoot: string, registry: Registry): PatternCheck {
  const want = new Map(registry.journeys.map((j) => [journeyFolder(j.id, j.title), j]));
  const folders = journeyFolders(evidenceRoot);
  const findings = folders
    .filter((d) => !want.has(d))
    .map((d) => {
      const renamed = [...want.keys()].find((k) => idOf(k) === idOf(d));
      return renamed
        ? `${d} — ${idOf(d)} is registered as \`${renamed}\`, so this is the old name`
        : `${d} — no journey in the registry is ${idOf(d)}`;
    });
  return { checked: folders.length, findings };
}

/**
 * **Every recording lives under a persona directory whose marker agrees with
 * it**, and the persona is one the journey declares.
 *
 * The marker's *contents* are checked, not merely its presence: the index keys
 * on the directory and takes the label from the file, so a folder called
 * `organizer` whose marker says `attendee` renders a page naming one persona and
 * describing the other — no throw, and it reads as though somebody meant it.
 */
export function personaPatternCheck(evidenceRoot: string, registry: Registry): PatternCheck {
  const findings: string[] = [];
  let checked = 0;
  for (const rec of recordedPaths(evidenceRoot)) {
    checked++;
    if (!rec.persona) {
      findings.push(
        `${rec.rel} — a path with no persona level; record it under <journey>/<persona>/`,
      );
      continue;
    }
    const journey = registry.journeys.find(
      (j) => journeyFolder(j.id, j.title) === rec.journeyFolder,
    );
    if (journey && rec.persona !== COMMON && !journey.personas.includes(rec.persona)) {
      findings.push(`${rec.rel} — ${journey.id} does not list persona "${rec.persona}"`);
    }
  }
  for (const folder of journeyFolders(evidenceRoot)) {
    for (const p of personaDirs(join(evidenceRoot, folder))) {
      const marker = readPersonaMarker(join(evidenceRoot, folder, p.dir));
      if (marker?.key !== p.dir)
        findings.push(`${folder}/${p.dir}/persona.json says key "${marker?.key}", not "${p.dir}"`);
      if (p.dir !== COMMON && !registry.personas[p.dir])
        findings.push(`${folder}/${p.dir} — not a persona in the registry`);
    }
  }
  return { checked, findings };
}

/**
 * **One spec file per walk, with the journey and persona in its name** —
 * `j4-signing-in.organizer.spec.ts` — and the name checked against the file:
 * a spec called `.organizer.` must record only `persona: "organizer"` walks,
 * or the directory scheme's protection fails one level up. A spec with no
 * journey in it (a fixture test) has no `persona:` and is not asked.
 */
export function specPatternCheck(specDir: string, registry: Registry): PatternCheck {
  const findings: string[] = [];
  const files = existsSync(specDir)
    ? readdirSync(specDir)
        .filter((f) => /\.spec\.(ts|mts)$/.test(f))
        .sort()
    : [];
  for (const file of files) {
    const source = readFileSync(join(specDir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const personas = [...source.matchAll(/\bpersona:\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    if (personas.length === 0) continue;
    const parts = parseSpecName(file);
    if (!parts) {
      findings.push(`${file} — records a journey, so it is named <id>-<slug>.<persona>.spec.ts`);
      continue;
    }
    const journey = registry.journeys.find((j) => j.id === parts.journey);
    if (!journey) findings.push(`${file} — ${parts.journey} is not in the registry`);
    if (parts.persona !== COMMON && !registry.personas[parts.persona]) {
      findings.push(`${file} — "${parts.persona}" is not a persona in the registry`);
    }
    for (const p of new Set(personas)) {
      if (p !== parts.persona)
        findings.push(`${file} — named for "${parts.persona}" and records persona "${p}"`);
    }
  }
  return { checked: files.length, findings };
}

/**
 * **Every spec resets the stack before its first test** — `test.beforeAll(resetJourneyStack)`,
 * or an async `beforeAll` whose first statement awaits it. A spec that forgot
 * runs on the previous journey's state and is red for a reason nobody changed;
 * a reset *after* building rows deletes them. Read from code, not comments.
 */
export function isolationPatternCheck(
  specDir: string,
  { reset = "resetJourneyStack" }: { reset?: string } = {},
): PatternCheck {
  const findings: string[] = [];
  const files = existsSync(specDir)
    ? readdirSync(specDir)
        .filter((f) => /\.spec\.(ts|mts)$/.test(f))
        .sort()
    : [];
  const bare = `test.beforeAll(${reset});`;
  const first = new RegExp(
    `test\\.beforeAll\\(\\s*async\\s*\\(\\s*\\)\\s*=>\\s*\\{\\s*await ${reset}\\(\\)\\s*;`,
  );
  for (const file of files) {
    const body = readFileSync(join(specDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (!body.includes(bare) && !first.test(body))
      findings.push(`${file} — does not call ${bare} before its first test`);
  }
  return { checked: files.length, findings };
}

/** All five, from one config, rooted at `root`. */
export function journeyPatternCheck(
  root: string,
  config: JourneysConfig,
  options: { knownOrphans?: readonly string[]; reset?: string } = {},
): Record<"snapshots" | "directories" | "personas" | "specs" | "isolation", PatternCheck> {
  const evidence = join(root, config.evidenceRoot);
  const specs = join(root, config.specDir);
  return {
    snapshots: snapshotPatternCheck(
      evidence,
      options.knownOrphans ? { knownOrphans: options.knownOrphans } : {},
    ),
    directories: directoryPatternCheck(evidence, config.registry),
    personas: personaPatternCheck(evidence, config.registry),
    specs: specPatternCheck(specs, config.registry),
    isolation: isolationPatternCheck(specs, options.reset ? { reset: options.reset } : {}),
  };
}
