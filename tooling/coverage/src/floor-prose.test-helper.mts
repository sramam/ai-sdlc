/**
 * A coverage floor is declared in one place (`sdlc.config.json`
 * `coverage.floors`) and quoted in none.
 *
 * In an earlier project two package guides quoted a floor, and both were a
 * point below the enforced value by the time anybody looked: the floors had
 * been raised and the prose beside them was not revisited. A branch then
 * landed 0.17 points from red against a gate its author believed had a point
 * of headroom. Asking again in prose is what had been tried; this counts it
 * instead.
 *
 * **What it looks for, and why not "a stale floor".** Deciding which numbers
 * are *meant* as floors is proximity as evidence, which is how pattern checks here go
 * wrong. So the rule is blunt and has no unsure case: a markdown line under
 * `docs/` that names *floor* or *coverage* carries no percentage, no slashed
 * figure pair (`92 / 88`), and no bare number equal to a declared floor value,
 * within `WINDOW` characters of the word. That catches a correct number written
 * today, which decays, and a stale one, which already has; the two cannot be
 * told apart by reading the file.
 *
 * `docs/quality/coverage.md` is exempt: it is written by the gate's own run and
 * regenerated, so it cannot drift. A historical figure that genuinely belongs
 * in prose (past tense about a floor that no longer exists cannot decay) is
 * declared with a reason, and the declaration list is a ratchet in both
 * directions: an entry whose text has left its file fails too.
 *
 * Used from a test (`*.test-helper.mts` is not collected as a test itself), so
 * a project's own suite runs `floorProsePatternCheck(root, …)` and asserts no offences.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export interface DeclaredQuote {
  /** Path relative to the root, e.g. `docs/kit/testing.md`. */
  file: string;
  /** The exact quoted text that may stay. */
  text: string;
  /** Why it cannot decay. Required to be a real sentence (40+ characters). */
  why: string;
}

export interface Offence {
  file: string;
  line: number;
  quote: string;
  text: string;
}

export interface PatternCheckOptions {
  /** Directory to scan, relative to root. Default `docs`. */
  dir?: string;
  /** Files exempt, relative to root. Default the generated report. */
  exempt?: string[];
  /** Declared floor values: a bare number equal to one is a quote too. */
  floors?: Record<string, { lines: number; branches: number }>;
  declared?: DeclaredQuote[];
}

export interface PatternCheckResult {
  scanned: string[];
  offences: Offence[];
  /** Declared quotes no longer in their file, or with no real reason. */
  staleDeclarations: string[];
}

/** How far from the word a number counts as "next to" it. */
export const WINDOW = 80;
const WORD = /\b(?:floors?|coverage)\b/gi;
const PERCENT = /(?<![\w#.])\d{1,3}(?:\.\d+)?\s?%/g;
const PAIR = /(?<![\w#./])\d{1,3}(?:\.\d+)? ?\/ ?\d{1,3}(?:\.\d+)?(?![\w./])/g;

function markdownFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && e.name !== "node_modules") walk(join(abs, e.name));
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(relative(root, join(abs, e.name)).split("\\").join("/"));
      }
    }
  };
  const start = join(root, dir);
  if (existsSync(start)) walk(start);
  return out.sort();
}

function numberPatterns(floors: PatternCheckOptions["floors"]): RegExp[] {
  const values = new Set<string>();
  for (const f of Object.values(floors ?? {})) {
    values.add(String(f.lines));
    values.add(String(f.branches));
  }
  const bare = [...values].map(
    (v) => new RegExp(`(?<![\\w#./-])${v.replace(".", "\\.")}(?![\\w%./-])`, "g"),
  );
  return [PERCENT, PAIR, ...bare];
}

/** Quotes within WINDOW characters of a floor/coverage word on one line. */
export function quotesInLine(line: string, patterns: RegExp[]): string[] {
  const words = [...line.matchAll(WORD)].map((m) => [m.index, m.index + m[0].length] as const);
  if (words.length === 0) return [];
  const found = new Map<number, string>();
  for (const re of patterns) {
    for (const m of line.matchAll(re)) {
      const [s, e] = [m.index, m.index + m[0].length];
      const near = words.some(([ws, we]) => s - we <= WINDOW && ws - e <= WINDOW);
      if (near && ![...found.keys()].some((k) => k <= s && s < k + (found.get(k)?.length ?? 0)))
        found.set(s, m[0]);
    }
  }
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, q]) => q);
}

export function floorProsePatternCheck(
  root: string,
  opts: PatternCheckOptions = {},
): PatternCheckResult {
  const exempt = new Set(opts.exempt ?? ["docs/quality/coverage.md"]);
  const declared = opts.declared ?? [];
  const patterns = numberPatterns(opts.floors);
  const scanned = markdownFiles(root, opts.dir ?? "docs").filter((f) => !exempt.has(f));
  const offences: Offence[] = [];
  for (const file of scanned) {
    const mine = declared.filter((d) => d.file === file).map((d) => d.text);
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((text, i) => {
        // A quote is allowed when a declared text on this line contains it.
        const here = mine.filter((d) => text.includes(d));
        for (const quote of quotesInLine(text, patterns)) {
          if (here.some((d) => d.includes(quote))) continue;
          offences.push({ file, line: i + 1, quote, text: text.trim() });
        }
      });
  }
  const staleDeclarations = declared.flatMap((d) => {
    const path = join(root, d.file);
    if (d.why.trim().length < 40) return [`${d.file}: "${d.text}" needs a real reason`];
    if (!existsSync(path) || !readFileSync(path, "utf8").includes(d.text))
      return [`${d.file} no longer contains "${d.text}": delete its declaration`];
    return [];
  });
  return { scanned, offences, staleDeclarations };
}

/** One message naming every offence, for an assertion's failure text. */
export function describeOffences(result: PatternCheckResult): string {
  return [
    "A coverage floor lives in sdlc.config.json and is quoted nowhere else.",
    "Reference it, or declare the quote with a reason it cannot decay:",
    ...result.offences.map((o) => `  ${o.file}:${o.line}  ${o.quote}  — ${o.text.slice(0, 100)}`),
    ...result.staleDeclarations.map((s) => `  ${s}`),
  ].join("\n");
}
