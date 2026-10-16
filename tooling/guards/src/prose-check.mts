/**
 * The prose pattern check: the signs of model-written text a regex can find,
 * over every markdown file an agent reads. The judgement patterns (a contrast
 * with nobody on the other side, a closer that restates, a saying that sounds
 * deep) stay with the code review and the humanizer skill; this catches the
 * mechanical ones before they are committed, the way lint catches a bare
 * `console.log`.
 *
 *   node tooling/guards/src/prose-check.mts [<file>…]   the named files (lint-staged),
 *                                                       else every tracked .md (ci:local)
 *
 * Rules, each a finding:
 *   dash      an em or en dash in prose. An en dash between two numbers is a
 *             range and is allowed (`55000–55499`, `§ 2–3`)
 *   bold      bold inside a sentence. A label at the start of a list item, a
 *             table cell or a paragraph is what an agent searches for and is
 *             allowed; `**only**` mid-sentence is decoration
 *   word      a stock model word: delve, crucial, leverage, seamless, tapestry…
 *   heading   a Title Case heading below the title, or a heading with an emoji
 *   quote     curly quotation marks
 *   residue   a chatbot wrapper or a staged opener: "Great question",
 *             "Let's dive in", "To be clear,", "In conclusion"
 *
 * Skipped: fenced code, inline code, YAML frontmatter, HTML comments, link
 * targets, block quotes (quoted upstream text), and the paths in EXCLUDED
 * (verbatim third-party copies, imported sources, fixtures).
 *
 * Exceptions: `<!-- prose-check: allow <rule>[, <rule>] (<reason>) -->` on the
 * line before the one it covers, or within the first five lines for the whole
 * file. A reason under three words is itself a finding: a rule is relaxed with
 * a reason or not at all (docs/kit/principles.md § 6).
 *
 * Exit 0 clean, 1 findings, 2 could not ask (git did not answer).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRoot } from "../../core/src/config.mts";
import { exec as realExec, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";

export type Rule = "dash" | "bold" | "word" | "heading" | "quote" | "residue" | "exception";

export interface Finding {
  file: string;
  line: number;
  rule: Rule;
  excerpt: string;
}

/** Path prefixes never checked, and why. */
export const EXCLUDED: Record<string, string> = {
  ".agents/3rdparty/": "verbatim third-party copies; amended in their wrappers, never edited",
  "docs/requirements/sources/": "imported source material, never edited",
  "node_modules/": "dependencies",
  ".claude/worktrees/": "other sessions' checkouts",
  "__fixtures__/": "test fixtures, read by tests rather than agents",
};

const STOCK_WORDS =
  /\b(?:delve[sd]?|delving|tapestry|testament|pivotal|showcas(?:e|es|ing|ed)|underscor(?:es|ing)|meticulous(?:ly)?|garner(?:ed|s)?|bolster(?:ed|s)?|enduring|intricate|intricacies|interplay|vibrant|groundbreaking|game-chang(?:er|ing)|seamless(?:ly)?|leverag(?:e|es|ing|ed)|crucial(?:ly)?|additionally|deep dive|it(?:'s| is) worth noting|in today's)\b/gi;

const RESIDUE =
  /\b(?:I hope this helps|Great question|Certainly!|Of course!|You're absolutely right|Let's dive in|Let's explore|Let's break this down|Here's what you need to know|Without further ado|In conclusion|In summary|To be clear,|It(?:'s| is) important to note|Don't get me wrong)/gi;

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const EXCEPTION = /<!--\s*prose-check:\s*allow\s+([a-z, ]+?)\s*\((.*?)\)\s*-->/;

export function isExcluded(path: string): boolean {
  return Object.keys(EXCLUDED).some((p) => path.startsWith(p) || path.includes(`/${p}`));
}

/**
 * The lines of a file with everything that is not prose blanked: code,
 * frontmatter, comments, quotes, link targets. Line numbers are preserved.
 */
export function proseLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let comment = false;
  let frontmatter = lines[0] === "---";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    if (frontmatter) {
      out.push("");
      if (i > 0 && line === "---") frontmatter = false;
      continue;
    }
    const fenceMark = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fence) {
      out.push("");
      if (fenceMark === fence) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      out.push("");
      continue;
    }
    if (comment) {
      const end = line.indexOf("-->");
      if (end === -1) {
        out.push("");
        continue;
      }
      comment = false;
      line = line.slice(end + 3);
    }
    if (/^\s*>/.test(line)) {
      out.push("");
      continue;
    }
    // Comments on one line vanish; one that opens here blanks the rest.
    line = line.replace(/<!--.*?-->/g, "");
    const open = line.indexOf("<!--");
    if (open !== -1) {
      comment = true;
      line = line.slice(0, open);
    }
    line = line
      .replace(/`[^`]*`/g, (m) => " ".repeat(m.length))
      .replace(/\]\([^)]*\)/g, "]()")
      .replace(/https?:\/\/\S+/g, "");
    out.push(line);
  }
  return out;
}

function isLabelPosition(lines: string[], i: number, line: string): boolean {
  const marker = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.exec(line);
  if (marker) return true;
  const prev = lines
    .slice(0, i)
    .reverse()
    .find((l) => l !== undefined);
  // A paragraph starts after a blank line, a heading, or the file's beginning.
  return prev === undefined || prev.trim() === "" || /^#{1,6}\s/.test(prev);
}

function titleCase(heading: string): boolean {
  const words = heading
    .replace(/[`*_:()[\]]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, ""))
    .filter((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w));
  // Words of four letters or more after the first, leaving out acronyms and
  // CamelCase product names. Three or more, all capitalised, is Title Case;
  // fewer is as likely a run of proper nouns ("Start on Workers").
  const candidates = words
    .slice(1)
    .filter((w) => w.length >= 4 && w !== w.toUpperCase() && !/^[A-Z].*[A-Z]/.test(w));
  return candidates.length >= 3 && candidates.every((w) => /^[A-Z]/.test(w));
}

/** The findings in one file's text. Pure: the file name only labels them. */
export function checkText(text: string, file: string): Finding[] {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const prose = proseLines(text);
  const findings: Finding[] = [];
  const add = (line: number, rule: Rule, excerpt: string) =>
    findings.push({ file, line, rule, excerpt: excerpt.trim().slice(0, 80) });

  const fileWide = new Set<string>();
  let nextLine = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const rawLine = raw[i] ?? "";
    const ex = EXCEPTION.exec(rawLine);
    if (ex) {
      const rules = (ex[1] ?? "").split(",").map((r) => r.trim());
      if ((ex[2] ?? "").trim().split(/\s+/).length < 3)
        add(i + 1, "exception", "an exception needs a reason of at least three words");
      const target =
        i < 5 && !raw.slice(0, i).some((l) => l.trim() && l !== "---") ? fileWide : nextLine;
      for (const r of rules) target.add(r);
      continue;
    }
    const line = prose[i] ?? "";
    // A blank line (prettier puts one after a comment) does not use up a
    // next-line exception; the next line with prose does.
    if (!line.trim()) continue;
    const allowed = new Set([...fileWide, ...nextLine]);
    nextLine = new Set();
    const ok = (rule: Rule) => !allowed.has(rule);

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const h = heading[1] ?? "";
      if (ok("heading")) {
        if (EMOJI.test(h)) add(i + 1, "heading", `emoji in a heading: ${h}`);
        else if (!/^#\s/.test(line) && titleCase(h)) add(i + 1, "heading", `Title Case: ${h}`);
      }
    }

    if (ok("dash")) {
      for (const m of line.matchAll(/[—–]/g)) {
        const at = m.index ?? 0;
        const range =
          m[0] === "–" && /\d/.test(line[at - 1] ?? "") && /\d/.test(line[at + 1] ?? "");
        if (!range) {
          add(i + 1, "dash", line);
          break;
        }
      }
    }

    if (ok("bold") && !heading) {
      const cells = line.startsWith("|") ? line.split("|") : [line];
      for (const cell of cells) {
        const m = /\*\*[^*\n]+\*\*/.exec(cell);
        if (!m) continue;
        const before = cell
          .slice(0, m.index)
          .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
        const atStart = before.trim() === "";
        const label = atStart && (cells.length > 1 || isLabelPosition(prose, i, line));
        const second = cell.slice((m.index ?? 0) + m[0].length);
        if (!label || /\*\*[^*\n]+\*\*/.test(second)) {
          add(i + 1, "bold", cell);
          break;
        }
      }
    }

    if (ok("word")) {
      const m = STOCK_WORDS.exec(line);
      STOCK_WORDS.lastIndex = 0;
      if (m) add(i + 1, "word", `"${m[0]}": ${line}`);
    }
    if (ok("quote") && /[“”‘’]/.test(line)) add(i + 1, "quote", line);
    if (ok("residue")) {
      const m = RESIDUE.exec(line);
      RESIDUE.lastIndex = 0;
      if (m) add(i + 1, "residue", `"${m[0]}": ${line}`);
    }
  }
  return findings;
}

export interface Outcome {
  state: "ok" | "refused" | "could-not-ask";
  files: number;
  findings: Finding[];
  reason?: string;
}

/** Every tracked markdown file, minus the excluded paths. */
export async function trackedMarkdown(root: string, exec: Exec): Promise<string[] | null> {
  const r = await exec("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  return r.stdout
    .split("\0")
    .filter((p) => p.endsWith(".md") && !isExcluded(p))
    .sort();
}

export async function runProseCheck(
  root: string,
  files: string[],
  exec: Exec = realExec,
): Promise<Outcome> {
  let targets = files.map((f) => f.replace(/\\/g, "/"));
  if (!targets.length) {
    const tracked = await trackedMarkdown(root, exec);
    if (!tracked)
      return { state: "could-not-ask", files: 0, findings: [], reason: "git ls-files failed" };
    targets = tracked;
  }
  targets = targets.filter((f) => f.endsWith(".md") && !isExcluded(f));
  const findings: Finding[] = [];
  for (const f of targets) {
    const abs = f.startsWith("/") ? f : join(root, f);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (e) {
      return {
        state: "could-not-ask",
        files: targets.length,
        findings,
        reason: `${f}: ${(e as Error).message}`,
      };
    }
    findings.push(...checkText(text, f));
  }
  return { state: findings.length ? "refused" : "ok", files: targets.length, findings };
}

export function print(o: Outcome, log: (l: string) => void): number {
  for (const f of o.findings) log(`  ${f.file}:${f.line}  ${f.rule.padEnd(9)} ${f.excerpt}`);
  if (o.state === "could-not-ask") {
    log(`prose-check: could not ask (${o.reason})`);
    return 2;
  }
  log(
    o.findings.length
      ? `prose-check: ${o.findings.length} finding(s) in ${o.files} file(s). Rewrite, or add <!-- prose-check: allow <rule> (<reason>) --> above the line`
      : `prose-check: ok, ${o.files} file(s) clean`,
  );
  return o.findings.length ? 1 : 0;
}

if (isEntry(import.meta.url)) {
  const root = findRoot() ?? process.cwd();
  const args = process.argv
    .slice(2)
    .map((f) => (f.startsWith(root) ? f.slice(root.length + 1) : f));
  process.exitCode = print(await runProseCheck(root, args), (l) => console.log(l));
}
