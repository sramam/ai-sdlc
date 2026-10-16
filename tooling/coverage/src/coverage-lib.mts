/**
 * The coverage arithmetic and the published report, shared by the gate and the
 * document so the two cannot disagree: two implementations of "what is the
 * coverage" are two answers, and the published one is the one people believe.
 *
 * Pure: nothing here runs a process or touches the filesystem except
 * `fingerprint`, which reads the files it is handed. Both suites emit
 * istanbul-shaped JSON over the same absolute paths, so merging is a counter
 * sum and nothing interprets anything.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

export interface Position {
  line: number;
  column: number;
}

export interface FileCoverage {
  path?: string;
  statementMap: Record<string, { start: Position; end: Position }>;
  fnMap: Record<string, unknown>;
  branchMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

/** `coverage-final.json`: absolute path → file coverage. */
export type CoverageJson = Record<string, FileCoverage>;

export type Pair = [covered: number, total: number];

export interface Summary {
  lines: number;
  branches: number;
  functions: number;
  statements: number;
  counts: { lines: Pair; branches: Pair; functions: Pair; statements: Pair };
}

/** The floors `sdlc.config.json` declares: path prefix → minimum percentages. */
export type Floors = Record<string, { lines: number; branches: number }>;

/** A map entry's location, which is what identifies it across runs. */
function locKey(entry: unknown): string {
  const e = entry as { start?: Position; end?: Position; loc?: { start: Position; end: Position } };
  const loc = e.loc ?? (e.start && e.end ? { start: e.start, end: e.end } : undefined);
  return loc
    ? `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`
    : JSON.stringify(entry);
}

/** Merge one counter kind by location: same location sums, a new one is added. */
function mergeKind<T>(
  intoMap: Record<string, unknown>,
  intoHits: Record<string, T>,
  fromMap: Record<string, unknown>,
  fromHits: Record<string, T>,
  add: (a: T, b: T) => T,
): void {
  const byLoc = new Map(Object.entries(intoMap).map(([k, v]) => [locKey(v), k]));
  let next = Object.keys(intoMap).length;
  for (const [k, entry] of Object.entries(fromMap)) {
    const hits = fromHits[k];
    if (hits === undefined) continue;
    const at = byLoc.get(locKey(entry));
    if (at !== undefined && intoHits[at] !== undefined) intoHits[at] = add(intoHits[at], hits);
    else {
      const key = String(next++);
      intoMap[key] = structuredClone(entry);
      intoHits[key] = structuredClone(hits);
      byLoc.set(locKey(entry), key);
    }
  }
}

/**
 * Sum `from` into a copy of `into`, matching entries **by source location**,
 * not by key. Measured: @vitest/coverage-v8 numbers branches per run, so the
 * same key names different code in the unit and integration outputs (the
 * earlier version summed by key and so added unrelated branches together).
 * This is also how istanbul-lib-coverage merges.
 *
 * Never mutates either argument: an earlier version mutated its first, so
 * `merged = unit` aliased the two and the report printed the merged figure as
 * the unit one — two plausible identical rows, invisible in the output.
 */
export function merge(into: CoverageJson, from: CoverageJson): CoverageJson {
  const out: CoverageJson = structuredClone(into);
  for (const [file, cov] of Object.entries(from)) {
    const existing = out[file];
    if (!existing) {
      out[file] = structuredClone(cov);
      continue;
    }
    const sum = (a: number, b: number) => a + b;
    mergeKind(existing.statementMap, existing.s, cov.statementMap, cov.s, sum);
    mergeKind(existing.fnMap, existing.f, cov.fnMap, cov.f, sum);
    mergeKind(existing.branchMap, existing.b, cov.branchMap, cov.b, (a, b) =>
      Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0)),
    );
  }
  return out;
}

/** A path relative to the root, with forward slashes. */
export function relPath(root: string, abs: string): string {
  const rel = relative(root, abs).split("\\").join("/");
  return rel;
}

/**
 * Does `rel` fall under the floor key `prefix`? `""` and `"."` mean the whole
 * repository. A segment boundary is required: `tooling/c` does not cover
 * `tooling/ci/…`.
 */
export function underPrefix(rel: string, prefix: string): boolean {
  const p = prefix.replace(/^\.\/?/, "").replace(/\/+$/, "");
  if (p === "") return true;
  return rel === p || rel.startsWith(`${p}/`);
}

/** Restrict coverage to the files `keep` accepts (by path relative to root). */
export function subset(
  cov: CoverageJson,
  root: string,
  keep: (rel: string) => boolean,
): CoverageJson {
  const out: CoverageJson = {};
  for (const [abs, c] of Object.entries(cov)) if (keep(relPath(root, abs))) out[abs] = c;
  return out;
}

/**
 * Lines are derived from the statement map the way istanbul's own line
 * coverage is: a line is covered when any statement starting on it ran.
 */
export function summarise(cov: CoverageJson): Summary {
  const counts: Summary["counts"] = {
    lines: [0, 0],
    branches: [0, 0],
    functions: [0, 0],
    statements: [0, 0],
  };
  for (const c of Object.values(cov)) {
    const lineHits = new Map<number, number>();
    for (const [k, hits] of Object.entries(c.s)) {
      counts.statements[1]++;
      if (hits > 0) counts.statements[0]++;
      const line = c.statementMap[k]?.start.line;
      if (line !== undefined) lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits));
    }
    for (const hits of lineHits.values()) {
      counts.lines[1]++;
      if (hits > 0) counts.lines[0]++;
    }
    for (const hits of Object.values(c.f)) {
      counts.functions[1]++;
      if (hits > 0) counts.functions[0]++;
    }
    for (const arms of Object.values(c.b)) {
      counts.branches[1] += arms.length;
      counts.branches[0] += arms.filter((h) => h > 0).length;
    }
  }
  // Nothing to cover is 100%, not NaN: an empty denominator has no gap.
  const pct = ([c, t]: Pair) => (t ? (100 * c) / t : 100);
  return {
    lines: pct(counts.lines),
    branches: pct(counts.branches),
    functions: pct(counts.functions),
    statements: pct(counts.statements),
    counts,
  };
}

export const uncoveredLines = (s: Summary): number => s.counts.lines[1] - s.counts.lines[0];

// ─── Floors ───────────────────────────────────────────────────────────────────

export type FloorState = "pass" | "fail" | "empty";

export interface FloorResult {
  prefix: string;
  floor: { lines: number; branches: number };
  measured: Summary;
  state: FloorState;
  /** Human lines naming each metric below its floor. */
  shortfalls: string[];
}

/**
 * Every floor is checked before anything exits: stopping at the first failure
 * sends somebody back for a second red build, having told them it was fixed.
 *
 * A prefix matching no covered file is `empty`, and fails: it is either a typo
 * or code that moved, and reading it as 100% would be a gate that cannot fail.
 */
export function applyFloors(cov: CoverageJson, root: string, floors: Floors): FloorResult[] {
  return Object.entries(floors)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, floor]) => {
      const part = subset(cov, root, (rel) => underPrefix(rel, prefix));
      const measured = summarise(part);
      if (Object.keys(part).length === 0)
        return { prefix, floor, measured, state: "empty" as const, shortfalls: [] };
      const shortfalls = (["lines", "branches"] as const)
        .filter((k) => measured[k] < floor[k])
        .map((k) => `${k}: ${measured[k].toFixed(2)}% < ${floor[k]}%`);
      return {
        prefix,
        floor,
        measured,
        state: shortfalls.length ? ("fail" as const) : ("pass" as const),
        shortfalls,
      };
    });
}

// ─── The fingerprint ──────────────────────────────────────────────────────────

/**
 * Everything a figure can depend on, hashed by content (not mtime: a checkout
 * changes an mtime without changing a number). `mode` is part of what produced
 * the figure — an integration suite appearing must invalidate a unit-only pass.
 * A false miss (a rewrite that changes nothing) costs a run; a false hit would
 * hide a change, which is why the file list errs wide.
 */
export function fingerprint(root: string, files: string[], mode: string): string {
  const hash = createHash("sha256");
  hash.update(`mode:${mode}\n`);
  for (const path of [...new Set(files)].sort()) {
    hash.update(relPath(root, path));
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(path)).digest());
  }
  return hash.digest("hex").slice(0, 16);
}

// ─── The report ───────────────────────────────────────────────────────────────

export const REPORT_PATH = "docs/quality/coverage.md";
export const START = "<!-- coverage:start -->";
export const END = "<!-- coverage:end -->";
const FINGERPRINT_PREFIX = "<!-- fingerprint: ";
export const UNSTAMPED = "unstamped";
/** How a merged report names itself, so a unit-only run can refuse to overwrite one. */
export const MERGED_MARKER = "the unit and integration suites, merged";

const HEAVIEST = 15;

export interface ReportInput {
  merged: CoverageJson;
  root: string;
  floors: Floors;
  /** Which runs produced the figure, as one phrase. */
  suites: string;
  /** Whether this run judges the floors (false: reported, not judged). */
  judged: boolean;
  /** The workspace unit a file belongs to (its nearest package.json directory). */
  moduleOf: (rel: string) => string;
  at: { sha: string; branch: string };
}

const pc = (n: number) => `${n.toFixed(1)}%`;
const num = (n: number) => n.toLocaleString("en-US");

function table(header: string[], align: string[], rows: string[][]): string {
  return [header, align, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/** The block between the markers (markers included). Deterministic for its input. */
export function renderReport(input: ReportInput): string {
  const { merged, root, floors } = input;
  const overall = summarise(merged);
  const files = Object.keys(merged).map((abs) => {
    const rel = relPath(root, abs);
    return { rel, mod: input.moduleOf(rel), summary: summarise({ [abs]: merged[abs]! }) };
  });

  const modules = [...new Set(files.map((f) => f.mod))]
    .map((mod) => ({
      mod,
      summary: summarise(subset(merged, root, (rel) => input.moduleOf(rel) === mod)),
      files: files.filter((f) => f.mod === mod).length,
    }))
    .sort(
      (a, b) => uncoveredLines(b.summary) - uncoveredLines(a.summary) || a.mod.localeCompare(b.mod),
    );

  const floorSection =
    Object.keys(floors).length === 0
      ? "No floors are declared (`coverage.floors` in `sdlc.config.json` is empty): **n/a**. The figure is reported and nothing is judged."
      : table(
          ["path", "floor: lines / branches", "today: lines / branches", "verdict"],
          ["---", "---", "---", "---"],
          applyFloors(merged, root, floors).map((r) => [
            `\`${r.prefix || "."}\``,
            `${r.floor.lines} / ${r.floor.branches}`,
            r.state === "empty"
              ? "no covered file"
              : `${pc(r.measured.lines)} / ${pc(r.measured.branches)}`,
            !input.judged ? "reported, not judged" : r.state === "pass" ? "pass" : "**FAIL**",
          ]),
        );

  const gaps = files
    .filter((f) => uncoveredLines(f.summary) > 0)
    .sort(
      (a, b) => uncoveredLines(b.summary) - uncoveredLines(a.summary) || a.rel.localeCompare(b.rel),
    );
  const shown = gaps.slice(0, HEAVIEST);
  const rest = gaps.slice(HEAVIEST);

  return `${START}
${FINGERPRINT_PREFIX}${UNSTAMPED} -->
<!-- Generated by \`pnpm coverage --report\`, the gate's own run. Do not edit between
     the markers: every figure is measured. The reading lives in README.md beside this file. -->

**${pc(overall.lines)} lines** · ${pc(overall.branches)} branches · ${pc(overall.functions)} functions: ${num(overall.counts.lines[0])} of ${num(overall.counts.lines[1])} lines covered, **${num(uncoveredLines(overall))} uncovered**.

Measured at \`${input.at.sha}\` (\`${input.at.branch}\`), from ${input.suites}.

## By module

Sorted by uncovered lines, which is where the work is: a percentage ranks a
four-line file alongside a four-hundred-line one.

${
  modules.length === 0
    ? "No source file was covered."
    : table(
        ["module", "lines", "branches", "functions", "files", "uncovered lines"],
        ["---", "---:", "---:", "---:", "---:", "---:"],
        modules.map((m) => [
          `\`${m.mod}\``,
          pc(m.summary.lines),
          pc(m.summary.branches),
          pc(m.summary.functions),
          String(m.files),
          num(uncoveredLines(m.summary)),
        ]),
      )
}

## Floors

${floorSection}

## Heaviest uncovered files

${
  shown.length === 0
    ? "Every covered line is covered."
    : table(
        ["file", "lines", "branches", "uncovered lines"],
        ["---", "---:", "---:", "---:"],
        shown.map((f) => [
          `\`${f.rel}\``,
          pc(f.summary.lines),
          pc(f.summary.branches),
          num(uncoveredLines(f.summary)),
        ]),
      ) +
      (rest.length
        ? `\n\n${rest.length} further files hold ${num(rest.reduce((n, f) => n + uncoveredLines(f.summary), 0))} uncovered lines between them.`
        : "")
}
${END}`;
}

const DOC_HEADER = `# Coverage: the numbers

Written by \`pnpm coverage --report\`. Text outside the markers is kept.
`;

/**
 * Replace the block between the markers, keeping everything outside them. A
 * file without markers gains the block at its end; no file gets a header too.
 * Rewriting with the same block returns the same text (idempotent).
 */
export function replaceBlock(existing: string | null, block: string): string {
  if (existing === null) return `${DOC_HEADER}\n${block}\n`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END, start === -1 ? 0 : start);
  if (start === -1 || end === -1) {
    const sep =
      existing.length === 0 || existing.endsWith("\n\n")
        ? ""
        : existing.endsWith("\n")
          ? "\n"
          : "\n\n";
    return `${existing}${sep}${block}\n`;
  }
  return existing.slice(0, start) + block + existing.slice(end + END.length);
}

/** The fingerprint a report was stamped with, or null (absent or unstamped). */
export function stampedFingerprint(text: string | null): string | null {
  if (text === null) return null;
  const line = text.split("\n").find((l) => l.startsWith(FINGERPRINT_PREFIX));
  if (!line) return null;
  const value = line
    .slice(FINGERPRINT_PREFIX.length)
    .replace(/-->\s*$/, "")
    .trim();
  return value === UNSTAMPED ? null : value;
}

/** Stamp a report once the gate has passed. Written unstamped before the gate. */
export function stamp(text: string, value: string): string {
  return text.replace(`${FINGERPRINT_PREFIX}${UNSTAMPED} -->`, `${FINGERPRINT_PREFIX}${value} -->`);
}
