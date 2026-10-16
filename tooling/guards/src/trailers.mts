/**
 * The commit trailer grammar (docs/kit/hooks.md § Commit trailers), enforced.
 *
 *   node tooling/guards/src/trailers.mts --message <file>       commit-msg hook
 *   node tooling/guards/src/trailers.mts --range [<base>] [--allow-unknown]   ci:local
 *
 * `--message` refuses (exit 1) when:
 *   - the staged change touches docs/requirements/ without
 *     `Requirements: kickoff|idea|add-requirement`
 *   - a `Progress:` or `Closes:` names an item not in docs/plan/items — the
 *     items git's index holds, so an item staged in this commit counts
 *   - a `Co-Authored-By:` differs from `.claude/settings.json` attribution.commit
 * and warns when an upstream-owned path is staged. One line per check.
 *
 * `--range` checks base..HEAD (default origin/<integration>..HEAD, falling back
 * to the local integration branch and saying so): at least one `Progress:` or
 * `No-Item:` across the range, and every Progress/Closes ID names an item.
 *
 * Choices where the spec leaves room:
 * - Trailers are parsed by git (`interpret-trailers --parse`, `%(trailers)`),
 *   so a body quoting a trailer is prose.
 * - Attribution: the trailer's value must equal the setting's exactly; the key
 *   is compared case-insensitively (`Co-authored-by` is the same trailer to
 *   git). Only a Co-Authored-By naming the **same address** as the setting (the
 *   AI's, e.g. noreply@anthropic.com) must match it exactly, so a model-named
 *   variant is refused while a human co-author with their own address is
 *   allowed. An absent or unreadable setting allows, and says so.
 * - During a merge (MERGE_HEAD present) the requirements check is skipped: the
 *   staged diff then carries the other branch's changes, which landed with
 *   their own trailer. Said on the line.
 * - On `--amend` only the newly staged diff is seen (git gives the hook no
 *   other); a requirements change already in the amended commit is not re-read.
 * - `--range` with no commits ahead of the base passes vacuously.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findRoot, loadConfig, upstreamPaths } from "../../core/src/config.mts";
import { exec, isEntry } from "../../core/src/exec.mts";
import {
  DEFAULT_DIRS,
  git,
  hasHead,
  integrationRef,
  loadItems,
  logTrailers,
  normId,
  parseFrontmatter,
  parseTrailerLines,
  trailerItemId,
  trailerValues,
} from "../../plan/src/plan-lib.mts";
import type { CommitTrailers, Dirs, Trailer } from "../../plan/src/plan-lib.mts";

export type LineState = "ok" | "refused" | "warn" | "unknown";

export interface CheckLine {
  name: string;
  state: LineState;
  text: string;
}

export const REQUIREMENTS_SKILLS = ["kickoff", "idea", "add-requirement"];

export const UPSTREAM_PATHS = upstreamPaths();

export function checkRequirementsTrailer(
  staged: string[],
  trailers: Trailer[],
  reqDir: string,
  merging: boolean,
): CheckLine {
  const prefix = `${reqDir.replace(/\/$/, "")}/`;
  // The directory's own README and placeholders describe the folder; they are
  // not requirements, so they need no requirements skill.
  const housekeeping = (p: string): boolean =>
    p === `${prefix}README.md` || p.endsWith("/.gitkeep");
  const touched = staged.filter((p) => p.startsWith(prefix) && !housekeeping(p));
  if (!touched.length)
    return { name: "requirements", state: "ok", text: `no staged path under ${prefix}` };
  if (merging)
    return {
      name: "requirements",
      state: "ok",
      text: `${touched.length} path(s) under ${prefix}, but this is a merge: not checked`,
    };
  const values = trailerValues(trailers, "Requirements").map(
    (v) => v.trim().split(/\s+/)[0]?.toLowerCase() ?? "",
  );
  if (values.some((v) => REQUIREMENTS_SKILLS.includes(v)))
    return {
      name: "requirements",
      state: "ok",
      text: `${touched.length} path(s) under ${prefix}, Requirements: ${values.join(", ")}`,
    };
  const got = values.length ? ` (got "${values.join(", ")}")` : "";
  return {
    name: "requirements",
    state: "refused",
    text: `this commit changes ${prefix} (${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ", …" : ""}) and has no Requirements: ${REQUIREMENTS_SKILLS.join("|")} trailer${got}. Only /kickoff, /idea and /add-requirement write there`,
  };
}

export function checkItemTrailers(
  trailers: Trailer[],
  itemIds: Set<string>,
  name = "items",
): CheckLine {
  const named: string[] = [];
  const missing: string[] = [];
  for (const key of ["Progress", "Closes"])
    for (const v of trailerValues(trailers, key)) {
      const id = trailerItemId(v);
      if (!id) missing.push(`${key}: (empty)`);
      else if (!itemIds.has(id)) missing.push(`${key}: ${id}`);
      else named.push(`${key}: ${id}`);
    }
  if (missing.length)
    return {
      name,
      state: "refused",
      text: `${missing.join(", ")} — no such item in docs/plan/items (IDs match case-insensitively)`,
    };
  return {
    name,
    state: "ok",
    text: named.length ? named.join(", ") : "no Progress:/Closes: trailer",
  };
}

export type AttributionSetting =
  { state: "set"; line: string } | { state: "absent"; reason: string };

export function readAttribution(root: string): AttributionSetting {
  const p = join(root, ".claude", "settings.json");
  if (!existsSync(p)) return { state: "absent", reason: ".claude/settings.json does not exist" };
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as { attribution?: { commit?: unknown } };
    const line = s.attribution?.commit;
    if (typeof line === "string" && line.trim()) return { state: "set", line: line.trim() };
    return { state: "absent", reason: "settings declare no attribution.commit" };
  } catch (e) {
    return {
      state: "absent",
      reason: `could not read .claude/settings.json (${(e as Error).message})`,
    };
  }
}

export function checkAttribution(trailers: Trailer[], setting: AttributionSetting): CheckLine {
  const co = trailers.filter((t) => t.key.toLowerCase() === "co-authored-by");
  if (!co.length) return { name: "attribution", state: "ok", text: "no Co-Authored-By trailer" };
  if (setting.state === "absent")
    return { name: "attribution", state: "ok", text: `allowed: ${setting.reason}` };
  const want = parseTrailerLines(setting.line)[0];
  if (!want || want.key.toLowerCase() !== "co-authored-by")
    return {
      name: "attribution",
      state: "ok",
      text: `allowed: attribution.commit is not a Co-Authored-By line ("${setting.line}")`,
    };
  // The AI's line is recognised by its address; people co-author under their own.
  const address = (v: string): string => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();
  const ai = address(want.value);
  const wrong = co.filter((t) => address(t.value) === ai && t.value !== want.value);
  if (wrong.length)
    return {
      name: "attribution",
      state: "refused",
      text: `Co-Authored-By: ${wrong.map((t) => t.value).join("; ")} differs from .claude/settings.json attribution.commit "${setting.line}". Use it exactly`,
    };
  return { name: "attribution", state: "ok", text: `matches attribution.commit` };
}

export function upstreamWarnings(
  staged: string[],
  upstream: string[] = UPSTREAM_PATHS,
): CheckLine[] {
  const hits = staged.filter((p) => upstream.some((u) => p.startsWith(u)));
  if (!hits.length)
    return [{ name: "upstream", state: "ok", text: "no upstream-owned path staged" }];
  return [
    {
      name: "upstream",
      state: "warn",
      text: `${hits.length} upstream-owned path(s) changed (${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ", …" : ""}). pnpm sdlc:update will overwrite them: change the starter instead, or list the module in modules.replaced`,
    },
  ];
}

export function checkRangeHasItem(commits: CommitTrailers[]): CheckLine {
  const with_ = commits.filter(
    (c) =>
      trailerValues(c.trailers, "Progress").length || trailerValues(c.trailers, "No-Item").length,
  );
  if (with_.length)
    return {
      name: "progress",
      state: "ok",
      text: `${with_.length} of ${commits.length} commit(s) carry Progress: or No-Item:`,
    };
  return {
    name: "progress",
    state: "refused",
    text: `none of ${commits.length} commit(s) carries a Progress: <ITEM-ID> or No-Item: <reason> trailer`,
  };
}

export function checkRangeItems(commits: CommitTrailers[], itemIds: Set<string>): CheckLine {
  const bad: string[] = [];
  let n = 0;
  for (const c of commits) {
    const r = checkItemTrailers(c.trailers, itemIds);
    n += trailerValues(c.trailers, "Progress").length + trailerValues(c.trailers, "Closes").length;
    if (r.state === "refused") bad.push(`${c.commit.slice(0, 10)} "${c.subject}": ${r.text}`);
  }
  if (bad.length) return { name: "items", state: "refused", text: bad.join("\n      ") };
  return { name: "items", state: "ok", text: `${n} Progress/Closes trailer(s), all name items` };
}

// ─── Gathering ────────────────────────────────────────────────────────────────

/** Item IDs in git's index (committed or staged), by file name and frontmatter. */
export function indexedItemIds(
  root: string,
  dirs: Dirs,
): { ok: true; ids: Set<string> } | { ok: false; reason: string } {
  const dir = `${dirs.plan}/items/`;
  const ls = git(root, ["ls-files", "-z", "--", dir]);
  if (!ls.ok) return ls;
  const ids = new Set<string>();
  for (const p of ls.stdout.split("\0").filter(Boolean)) {
    const name = p.slice(dir.length);
    const m = /^((?:F\d+-\d+)|(?:X-\d+))(?:-|\.md$)/i.exec(name);
    if (m && m[1]) ids.add(normId(m[1]));
    const blob = git(root, ["show", `:${p}`]);
    if (blob.ok) {
      const id = parseFrontmatter(blob.stdout).data.id;
      if (typeof id === "string" && id.trim()) ids.add(normId(id));
    }
  }
  return { ok: true, ids };
}

function print(lines: CheckLine[]): void {
  const label: Record<LineState, string> = {
    ok: "ok",
    refused: "REFUSED",
    warn: "warn",
    unknown: "COULD NOT ASK",
  };
  for (const l of lines)
    console.log(`  ${label[l.state].padEnd(13)} ${l.name.padEnd(13)} ${l.text}`);
}

async function dirsFor(
  root: string,
): Promise<{ dirs: Dirs; integration: string; upstream: string[] }> {
  try {
    const cfg = await loadConfig(root);
    return {
      dirs: { requirements: cfg.dirs.requirements, plan: cfg.dirs.plan, adr: cfg.dirs.adr },
      integration: cfg.branches.integration,
      upstream: upstreamPaths(cfg.modules?.replaced ?? []),
    };
  } catch {
    return { dirs: DEFAULT_DIRS, integration: "dev", upstream: UPSTREAM_PATHS };
  }
}

export async function messageMode(root: string, file: string): Promise<number> {
  const { dirs, upstream } = await dirsFor(root);
  console.log("trailers: commit-msg");
  const parsed = git(root, ["interpret-trailers", "--parse", file]);
  if (!parsed.ok) {
    print([
      {
        name: "parse",
        state: "unknown",
        text: `could not ask git to parse the message: ${parsed.reason}`,
      },
    ]);
    return 1;
  }
  const trailers = parseTrailerLines(parsed.stdout);
  const staged = git(root, ["diff", "--cached", "--name-only", "-z"]);
  const items = indexedItemIds(root, dirs);
  const lines: CheckLine[] = [];
  if (!staged.ok)
    lines.push({
      name: "staged",
      state: "unknown",
      text: `could not ask git for the staged paths: ${staged.reason}`,
    });
  const paths = staged.ok ? staged.stdout.split("\0").filter(Boolean) : [];
  const gitDir = git(root, ["rev-parse", "--git-dir"]);
  const merging = gitDir.ok && existsSync(join(root, gitDir.stdout.trim(), "MERGE_HEAD"));
  if (staged.ok) lines.push(checkRequirementsTrailer(paths, trailers, dirs.requirements, merging));
  if (items.ok) lines.push(checkItemTrailers(trailers, items.ids));
  else
    lines.push({
      name: "items",
      state: "unknown",
      text: `could not ask git for the items: ${items.reason}`,
    });
  lines.push(checkAttribution(trailers, readAttribution(root)));
  // Only a project (which has a `starter` remote, added in Phase 0) is downstream.
  // In the starter itself these paths are the source, so there is nothing to warn about.
  if (staged.ok) {
    const isProject =
      (await exec("git", ["remote", "get-url", "starter"], { cwd: root })).code === 0;
    lines.push(
      ...(isProject
        ? upstreamWarnings(paths, upstream)
        : [
            {
              name: "upstream",
              state: "ok" as const,
              text: "no starter remote: this is the starter, or not yet a project",
            },
          ]),
    );
  }
  print(lines);
  const bad = lines.filter((l) => l.state === "refused" || l.state === "unknown");
  if (bad.length) {
    console.log("trailers: commit refused (docs/kit/hooks.md § Commit trailers)");
    return 1;
  }
  return 0;
}

export async function rangeMode(
  root: string,
  base: string | undefined,
  allowUnknown: boolean,
): Promise<number> {
  const { dirs, integration } = await dirsFor(root);
  let from = base;
  console.log("trailers: range");
  if (!hasHead(root)) {
    print([{ name: "range", state: "ok", text: "no commits yet: nothing to check" }]);
    return 0;
  }
  if (!from) {
    const ref = integrationRef(root, integration);
    if (ref.ref === null) {
      print([{ name: "range", state: "unknown", text: ref.note }]);
      return allowUnknown ? 0 : 1;
    }
    if (ref.note) print([{ name: "base", state: "warn", text: ref.note }]);
    from = ref.ref;
  }
  const log = logTrailers(root, [`${from}..HEAD`]);
  if (!log.ok) {
    print([
      {
        name: "range",
        state: "unknown",
        text: `could not ask git for ${from}..HEAD: ${log.reason}`,
      },
    ]);
    return allowUnknown ? 0 : 1;
  }
  if (!log.commits.length) {
    print([{ name: "range", state: "ok", text: `no commits in ${from}..HEAD: nothing to check` }]);
    return 0;
  }
  const ids = new Set(
    loadItems(root, dirs).flatMap((i) => [i.id, ...(i.fileId ? [i.fileId] : [])]),
  );
  const lines = [
    {
      name: "range",
      state: "ok" as const,
      text: `${log.commits.length} commit(s) in ${from}..HEAD`,
    },
    checkRangeHasItem(log.commits),
    checkRangeItems(log.commits, ids),
  ];
  print(lines);
  return lines.some((l) => l.state === "refused") ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const root = findRoot() ?? process.cwd();
  const mi = argv.indexOf("--message");
  if (mi >= 0) {
    const file = argv[mi + 1];
    if (!file) {
      console.error("trailers: --message needs the message file");
      return 2;
    }
    return messageMode(root, resolve(file));
  }
  const ri = argv.indexOf("--range");
  if (ri >= 0) {
    const next = argv[ri + 1];
    return rangeMode(
      root,
      next && !next.startsWith("--") ? next : undefined,
      argv.includes("--allow-unknown"),
    );
  }
  console.error("usage: trailers.mts --message <file> | --range [<base>] [--allow-unknown]");
  return 2;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
