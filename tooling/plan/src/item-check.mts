/**
 * `pnpm item-check <ID>` — has the ground this item stands on moved since it
 * was written?
 *
 * An item is a report about a moment. This lists, for every path the item's
 * frontmatter or body names, the commits that touched it since the item file
 * was first committed. A report, never a gate: it does not reproduce anything.
 *
 * Paths are read from backticked spans and bare tokens that look like paths: a
 * token with a `/` whose last segment has an extension, ends in `/`, or exists
 * on disk; or a single `name.ext` that exists. URLs are skipped.
 *
 * "Since" is the committer date of the item file's first commit
 * (`git log --since`), excluding that commit, over HEAD's history.
 *
 * Exit: 0 with a report; 1 when it could not ask (git unavailable, the item
 * file not committed, or the item names no path); 2 for an unknown item or bad
 * usage.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import { isEntry } from "../../core/src/exec.mts";
import { DEFAULT_DIRS, git, loadItems, normId } from "./plan-lib.mts";
import type { Dirs } from "./plan-lib.mts";

const TRAIL = /[.,;:)\]'"]+$/;

/** The paths an item's text names (see the header for what counts). */
export function pathsNamed(text: string, exists: (p: string) => boolean = () => false): string[] {
  const out = new Set<string>();
  const consider = (raw: string) => {
    const p = raw.trim().replace(TRAIL, "").replace(/^\.\//, "");
    if (
      !p ||
      /\s/.test(p) ||
      /^[a-z]+:\/\//i.test(p) ||
      p.startsWith("-") ||
      p.includes("<") ||
      p.includes("://")
    )
      return;
    if (/^[\w-]+:/.test(p) && !p.includes("/")) return;
    const last = p.replace(/\/$/, "").split("/").pop() ?? "";
    const hasExt = /\.[A-Za-z0-9]{1,6}$/.test(last);
    if (p.includes("/")) {
      if (hasExt || p.endsWith("/") || exists(p)) out.add(p);
    } else if (hasExt && exists(p)) out.add(p);
  };
  for (const m of text.matchAll(/`([^`\n]+)`/g)) if (m[1]) consider(m[1]);
  const bare = text.replace(/`[^`\n]*`/g, " ").replace(/\b[a-z]+:\/\/\S+/gi, " ");
  for (const m of bare.matchAll(/(?<![\w/.@-])((?:[\w.@-]+\/)+[\w.@*-]*)/g))
    if (m[1]) consider(m[1]);
  for (const m of bare.matchAll(/(?<![\w/.@-])([\w-]+\.[A-Za-z0-9]{1,6})(?![\w/])/g))
    if (m[1]) consider(m[1]);
  return [...out].sort();
}

export async function main(argv: string[]): Promise<number> {
  const arg = argv.find((a) => !a.startsWith("--"));
  if (!arg) {
    console.error("usage: pnpm item-check <ITEM-ID>");
    return 2;
  }
  const root = findRoot();
  if (!root) {
    console.error("item-check: could not find sdlc.config.ts above the current directory");
    return 2;
  }
  let dirs: Dirs = DEFAULT_DIRS;
  try {
    const cfg = await loadConfig(root);
    dirs = { requirements: cfg.dirs.requirements, plan: cfg.dirs.plan, adr: cfg.dirs.adr };
  } catch {
    /* defaults */
  }
  return itemCheck(root, dirs, arg, (l) => console.log(l));
}

/** The report for one item; returns the exit code. */
export function itemCheck(
  root: string,
  dirs: Dirs,
  arg: string,
  log: (line: string) => void,
): number {
  const id = normId(arg);
  const item = loadItems(root, dirs).find((i) => i.id === id || i.fileId === id);
  if (!item) {
    log(`item-check: no item ${id} in ${dirs.plan}/items`);
    return 2;
  }
  log(`item-check: ${item.id} ${item.title} (${item.file})`);
  const added = git(root, [
    "log",
    "--diff-filter=A",
    "--follow",
    "--format=%H%x09%cI",
    "--",
    item.file,
  ]);
  if (!added.ok) {
    log(`  COULD NOT ASK  git: ${added.reason}`);
    return 1;
  }
  const first = added.stdout.trim().split("\n").filter(Boolean).pop();
  if (!first) {
    log(`  COULD NOT ASK  ${item.file} has never been committed, so there is no "since"`);
    return 1;
  }
  const [firstSha = "", since = ""] = first.split("\t");
  const paths = pathsNamed(item.raw, (p) => existsSync(join(root, p)));
  if (!paths.length) {
    log("  COULD NOT ASK  the item names no path, so nothing can be checked");
    return 1;
  }
  log(`  since ${since} (${firstSha.slice(0, 10)}, the item's first commit)`);
  let moved = 0;
  for (const p of paths) {
    const hist = git(root, [
      "log",
      `--since=${since}`,
      "--format=%H%x09%h %as %s",
      "HEAD",
      "--",
      p,
    ]);
    if (!hist.ok) {
      log(`  COULD NOT ASK  ${p}: ${hist.reason}`);
      continue;
    }
    const commits = hist.stdout
      .split("\n")
      .filter(Boolean)
      .filter((l) => !l.startsWith(firstSha))
      .map((l) => l.split("\t")[1] ?? l);
    if (!commits.length) {
      log(`  steady         ${p}`);
      continue;
    }
    moved++;
    log(`  MOVED ${String(commits.length).padStart(3)}      ${p}`);
    for (const c of commits.slice(0, 10)) log(`      ${c}`);
    if (commits.length > 10) log(`      … ${commits.length - 10} more`);
  }
  log(`item-check: ${moved} of ${paths.length} named path(s) moved since the item was written`);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
