/**
 * The commit trailer grammar (docs/kit/hooks.md § Commit trailers), enforced.
 *
 *   node tooling/guards/src/trailers.mts --message <file>       commit-msg hook
 *   node tooling/guards/src/trailers.mts --range [<base>] [--allow-unknown]   ci:local
 *
 * **A trailer is an assertion, not proof.** `Requirements: spec` says a
 * requirements skill made the change; nothing here can tell which skill ran,
 * or whether any did. What these checks buy is consistency — every
 * requirements change asserts one, every named item exists, a branch closes
 * only its own item — which is what reporting reads. They are not security.
 *
 * `--message` refuses (exit 1) when:
 *   - the change touches docs/requirements/ without
 *     `Requirements: kickoff|spec` (or a pre-2026-10 name). During a merge (MERGE_HEAD
 *     present) only the merge's **own** changes count — staged paths that also
 *     differ from every merged head (a conflict resolution, an edit made while
 *     merging); what a merged head brings landed with its own trailer
 *   - a `Progress:` or `Closes:` names an item not in docs/plan/items — the
 *     items git's index holds, so an item staged in this commit counts
 *   - a `No-Item:` gives no real reason (under three words), or sits beside a
 *     `Closes:` — a commit cannot both finish an item and have none
 *   - a `Co-Authored-By:` differs from `.claude/settings.json` attribution.commit
 * One line per check.
 *
 * `--range` checks base..HEAD (default origin/<integration>..HEAD, falling back
 * to the local integration branch and saying so), **every commit and the
 * aggregate diff**:
 *   - at least one `Progress:` or `No-Item:` across the range
 *   - every Progress/Closes ID names an item; every No-Item: is well formed
 *   - every commit touching docs/requirements/ carries `Requirements:`. A
 *     merge commit is held to its own diff: paths that differ from its first
 *     parent **and** from every other parent (`git diff-tree -c`). A path a
 *     merge takes unchanged from a parent is that parent's, and that parent's
 *     commits are either in the range (checked) or on the base (landed)
 *   - every requirements path in the aggregate `base...HEAD` diff is owned by
 *     some commit in the range — a backstop for history the per-commit walk
 *     cannot attribute
 *   - when the aggregate diff changes source, it changes a test too, or some
 *     commit carries `No-Test: <reason>` (test-driven-development's evidence)
 *   - on a branch named after an item (`<id>` lowercased, optionally
 *     `-<slug>`), every `Closes:` names that item; a `Progress:` naming another
 *     item warns
 *   - `Claim: <ID>` commits are exempt: `pnpm claim` creates them through the
 *     GitHub API, so they carry no trailers
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
 * - On `--amend` only the newly staged diff is seen (git gives the hook no
 *   other); a requirements change already in the amended commit is not
 *   re-read. `--range` reads it.
 * - `--range` with no commits ahead of the base passes vacuously.
 * */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import { isEntry } from "../../core/src/exec.mts";
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

/**
 * `kickoff` and `spec` write requirements now. `idea` and `add-requirement`
 * were their names before October 2026, and a branch older than that still
 * carries them, so they stay valid here; the lock no longer accepts them.
 */
export const REQUIREMENTS_SKILLS = ["kickoff", "spec", "idea", "add-requirement"];

/**
 * `paths` are the change's own paths. For a merge (`merging`), the caller has
 * already reduced them to what the merge itself introduced; the line says so.
 */
/**
 * A path that changes requirements: under the requirements directory, minus
 * the directory's own README and placeholders, which describe the folder and
 * are not requirements. The commit-msg check and `pnpm land` share this rule,
 * so a README touch is never held to the requirements skills or to a branch
 * of its own by one layer and waved through by the other.
 */
export function isRequirementsPath(path: string, reqDir: string): boolean {
  const prefix = `${reqDir.replace(/\/+$/, "")}/`;
  return path.startsWith(prefix) && path !== `${prefix}README.md` && !path.endsWith("/.gitkeep");
}

export function checkRequirementsTrailer(
  staged: string[],
  trailers: Trailer[],
  reqDir: string,
  merging: boolean,
): CheckLine {
  const prefix = `${reqDir.replace(/\/$/, "")}/`;
  const touched = staged.filter((p) => isRequirementsPath(p, prefix));
  const own = merging ? " this merge's own" : "";
  if (!touched.length)
    return { name: "requirements", state: "ok", text: `no${own} path under ${prefix}` };
  const values = trailerValues(trailers, "Requirements").map(
    (v) => v.trim().split(/\s+/)[0]?.toLowerCase() ?? "",
  );
  if (values.some((v) => REQUIREMENTS_SKILLS.includes(v)))
    return {
      name: "requirements",
      state: "ok",
      text: `${touched.length}${own} path(s) under ${prefix}, Requirements: ${values.join(", ")}`,
    };
  const got = values.length ? ` (got "${values.join(", ")}")` : "";
  return {
    name: "requirements",
    state: "refused",
    text: `this ${merging ? "merge itself" : "commit"} changes ${prefix} (${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ", …" : ""}) and has no Requirements: ${REQUIREMENTS_SKILLS.join("|")} trailer${got}. Only /kickoff and /spec write there`,
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

/** `pnpm claim` makes these through the GitHub API; they carry no trailers. */
export function isClaimCommit(c: Pick<CommitTrailers, "subject">): boolean {
  return /^Claim:\s+\S+/.test(c.subject);
}

export const NO_ITEM_MIN_WORDS = 3;

/** `No-Item:` needs a reason a reader can act on, and cannot sit beside `Closes:`. */
export function checkNoItem(trailers: Trailer[], name = "no-item"): CheckLine {
  const reasons = trailerValues(trailers, "No-Item");
  if (!reasons.length) return { name, state: "ok", text: "no No-Item: trailer" };
  const closes = trailerValues(trailers, "Closes");
  if (closes.length)
    return {
      name,
      state: "refused",
      text: `No-Item: beside Closes: ${closes.join(", ")} — a commit that finishes an item has one. Drop the No-Item:`,
    };
  const thin = reasons.filter(
    (r) => r.trim().split(/\s+/).filter(Boolean).length < NO_ITEM_MIN_WORDS,
  );
  if (thin.length)
    return {
      name,
      state: "refused",
      text: `No-Item: ${thin.map((r) => `"${r}"`).join(", ")} — give a reason of at least ${NO_ITEM_MIN_WORDS} words (a revert of X, a dependency bump, a progress report)`,
    };
  return { name, state: "ok", text: `No-Item: ${reasons.join("; ")}` };
}

export function checkRangeNoItem(commits: CommitTrailers[]): CheckLine {
  const bad = commits
    .map((c) => ({ c, r: checkNoItem(c.trailers) }))
    .filter(({ r }) => r.state === "refused")
    .map(({ c, r }) => `${c.commit.slice(0, 10)} "${c.subject}": ${r.text}`);
  if (bad.length) return { name: "no-item", state: "refused", text: bad.join("\n      ") };
  const n = commits.filter((c) => trailerValues(c.trailers, "No-Item").length).length;
  return { name: "no-item", state: "ok", text: `${n} commit(s) carry a well-formed No-Item:` };
}

/** Code that runs: TypeScript or JavaScript outside tests, fixtures and type declarations. */
export function isSource(path: string): boolean {
  return (
    /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) &&
    !isTest(path) &&
    !/\.d\.[cm]?ts$/.test(path) &&
    !/(?:^|\/)__fixtures__\//.test(path) &&
    !/(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(path)
  );
}

export function isTest(path: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /^e2e\//.test(path);
}

/**
 * A branch that changes source carries a test, the evidence that
 * test-driven-development's red step happened, unless a commit says why not
 * with `No-Test: <reason>` (a rename, a type-only change, generated code).
 */
export function checkRangeTests(paths: string[], commits: CommitTrailers[]): CheckLine {
  const source = paths.filter(isSource);
  const tests = paths.filter(isTest);
  if (!source.length) return { name: "tests", state: "ok", text: "no source changed" };
  if (tests.length)
    return {
      name: "tests",
      state: "ok",
      text: `${source.length} source file(s) changed, ${tests.length} test file(s) with them`,
    };
  const reasons = commits
    .flatMap((c) => trailerValues(c.trailers, "No-Test"))
    .filter((r) => r.trim());
  if (reasons.length)
    return {
      name: "tests",
      state: "ok",
      text: `${source.length} source file(s) changed and no test, because: ${reasons.join("; ")}`,
    };
  return {
    name: "tests",
    state: "refused",
    text:
      `${source.length} source file(s) changed (${source.slice(0, 3).join(", ")}${source.length > 3 ? ", …" : ""}) ` +
      "and no test file did: add the test that proves it, or say why not with a `No-Test: <reason>` trailer",
  };
}

/** A commit with the paths it is answerable for (its own diff; see the header). */
export interface CommitPaths extends CommitTrailers {
  paths: string[];
  merge: boolean;
}

export function checkRangeRequirements(commits: CommitPaths[], reqDir: string): CheckLine {
  const bad: string[] = [];
  let touching = 0;
  for (const c of commits) {
    const r = checkRequirementsTrailer(c.paths, c.trailers, reqDir, c.merge);
    if (!/^no /.test(r.text)) touching++;
    if (r.state === "refused") bad.push(`${c.commit.slice(0, 10)} "${c.subject}": ${r.text}`);
  }
  if (bad.length) return { name: "requirements", state: "refused", text: bad.join("\n      ") };
  return {
    name: "requirements",
    state: "ok",
    text: touching
      ? `${touching} commit(s) change ${reqDir}/, each with Requirements:`
      : `no commit in the range changes ${reqDir}/`,
  };
}

/** Requirements paths in the aggregate diff that no commit in the range owns. */
export function checkAggregateRequirements(
  aggregate: string[],
  commits: CommitPaths[],
  reqDir: string,
): CheckLine {
  const prefix = `${reqDir.replace(/\/$/, "")}/`;
  const touched = aggregate.filter(
    (p) => p.startsWith(prefix) && p !== `${prefix}README.md` && !p.endsWith("/.gitkeep"),
  );
  if (!touched.length)
    return { name: "aggregate", state: "ok", text: `the range's diff leaves ${prefix} unchanged` };
  const owned = new Set(commits.flatMap((c) => c.paths));
  const orphan = touched.filter((p) => !owned.has(p));
  if (orphan.length)
    return {
      name: "aggregate",
      state: "refused",
      text: `the range changes ${orphan.slice(0, 3).join(", ")}${orphan.length > 3 ? ", …" : ""} but no commit in it owns the change — rebase or merge the base, then re-run`,
    };
  return {
    name: "aggregate",
    state: "ok",
    text: `${touched.length} path(s) under ${prefix}, each owned by a commit in the range`,
  };
}

/** The item a branch is named after (`<id>` or `<id>-<slug>`, lowercased), or null. */
export function itemOfBranch(branch: string, itemIds: Iterable<string>): string | null {
  const b = branch.toLowerCase();
  let best: string | null = null;
  for (const id of itemIds) {
    const l = id.toLowerCase();
    if ((b === l || b.startsWith(`${l}-`)) && (!best || l.length > best.length)) best = id;
  }
  return best;
}

export function checkBranchItems(
  branch: string | null,
  item: string | null,
  commits: CommitTrailers[],
): CheckLine[] {
  if (branch === null)
    return [
      { name: "branch", state: "ok", text: "detached HEAD: branch/item consistency not checked" },
    ];
  if (item === null)
    return [{ name: "branch", state: "ok", text: `${branch} is not named after an item` }];
  const want = normId(item);
  const closes: string[] = [];
  const progress: string[] = [];
  for (const c of commits) {
    const where = `${c.commit.slice(0, 10)} "${c.subject}"`;
    for (const v of trailerValues(c.trailers, "Closes")) {
      const id = trailerItemId(v);
      if (id && id !== want) closes.push(`${where}: Closes: ${id}`);
    }
    for (const v of trailerValues(c.trailers, "Progress")) {
      const id = trailerItemId(v);
      if (id && id !== want) progress.push(`${where}: Progress: ${id}`);
    }
  }
  const lines: CheckLine[] = [];
  lines.push(
    closes.length
      ? {
          name: "branch",
          state: "refused",
          text: `branch ${branch} is ${want}'s, and closes another item — ${closes.join("; ")}. Close it on its own branch`,
        }
      : {
          name: "branch",
          state: "ok",
          text: `branch ${branch} is ${want}'s; every Closes: names it`,
        },
  );
  if (progress.length)
    lines.push({
      name: "branch",
      state: "warn",
      text: `Progress: on other items from ${want}'s branch — ${progress.join("; ")}`,
    });
  return lines;
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

/**
 * The paths a commit is answerable for: its diff against its parent (or the
 * empty tree), or — for a merge — the paths that differ from every parent.
 */
export function commitPaths(
  root: string,
  commit: string,
): { ok: true; paths: string[]; merge: boolean } | { ok: false; reason: string } {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", commit]);
  if (!parents.ok) return parents;
  const merge = parents.stdout.trim().split(/\s+/).length > 2;
  const r = git(root, [
    "diff-tree",
    "-r",
    "--no-commit-id",
    "--name-only",
    "-z",
    merge ? "-c" : "--root",
    commit,
  ]);
  if (!r.ok) return r;
  return { ok: true, paths: r.stdout.split("\0").filter(Boolean), merge };
}

/** During a merge: staged paths that also differ from every merged head. */
export function mergeOwnPaths(
  root: string,
  staged: string[],
  heads: string[],
): { ok: true; paths: string[] } | { ok: false; reason: string } {
  let own = new Set(staged);
  for (const head of heads) {
    const r = git(root, ["diff", "--cached", "--name-only", "-z", head]);
    if (!r.ok) return r;
    const differs = new Set(r.stdout.split("\0").filter(Boolean));
    own = new Set([...own].filter((p) => differs.has(p)));
  }
  return { ok: true, paths: [...own] };
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

async function dirsFor(root: string): Promise<{ dirs: Dirs; integration: string }> {
  try {
    const cfg = await loadConfig(root);
    return {
      dirs: { requirements: cfg.dirs.requirements, plan: cfg.dirs.plan, adr: cfg.dirs.adr },
      integration: cfg.branches.integration,
    };
  } catch {
    return { dirs: DEFAULT_DIRS, integration: "dev" };
  }
}

export async function messageMode(root: string, file: string): Promise<number> {
  const { dirs } = await dirsFor(root);
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
  const mergeHead = gitDir.ok ? join(root, gitDir.stdout.trim(), "MERGE_HEAD") : null;
  const merging = mergeHead !== null && existsSync(mergeHead);
  if (staged.ok && !merging)
    lines.push(checkRequirementsTrailer(paths, trailers, dirs.requirements, false));
  else if (staged.ok && mergeHead) {
    const heads = readFileSync(mergeHead, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const own = mergeOwnPaths(root, paths, heads);
    lines.push(
      own.ok
        ? checkRequirementsTrailer(own.paths, trailers, dirs.requirements, true)
        : {
            name: "requirements",
            state: "unknown",
            text: `could not ask git which paths this merge changes itself: ${own.reason}`,
          },
    );
  }
  lines.push(checkNoItem(trailers));
  if (items.ok) lines.push(checkItemTrailers(trailers, items.ids));
  else
    lines.push({
      name: "items",
      state: "unknown",
      text: `could not ask git for the items: ${items.reason}`,
    });
  lines.push(checkAttribution(trailers, readAttribution(root)));
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
  const claims = log.commits.filter(isClaimCommit);
  const commits = log.commits.filter((c) => !isClaimCommit(c));
  const claimNote = claims.length ? `; ${claims.length} Claim: commit(s) exempt` : "";
  if (!commits.length) {
    print([
      {
        name: "range",
        state: "ok",
        text: `${from}..HEAD holds only Claim: commits${claimNote}: nothing to check`,
      },
    ]);
    return 0;
  }
  const items = loadItems(root, dirs);
  const ids = new Set(items.flatMap((i) => [i.id, ...(i.fileId ? [i.fileId] : [])]));

  const lines: CheckLine[] = [
    {
      name: "range",
      state: "ok",
      text: `${log.commits.length} commit(s) in ${from}..HEAD${claimNote}`,
    },
    checkRangeHasItem(commits),
    checkRangeItems(commits, ids),
    checkRangeNoItem(commits),
  ];

  // Every commit's own paths, then the aggregate.
  const withPaths: CommitPaths[] = [];
  const unread: string[] = [];
  for (const c of commits) {
    const p = commitPaths(root, c.commit);
    if (p.ok) withPaths.push({ ...c, paths: p.paths, merge: p.merge });
    else unread.push(`${c.commit.slice(0, 10)}: ${p.reason}`);
  }
  if (unread.length)
    lines.push({
      name: "requirements",
      state: "unknown",
      text: `could not ask git for the paths of ${unread.join("; ")}`,
    });
  else {
    lines.push(checkRangeRequirements(withPaths, dirs.requirements));
    const agg = git(root, ["diff", "--name-only", "-z", `${from}...HEAD`]);
    const aggPaths = agg.ok ? agg.stdout.split("\0").filter(Boolean) : [];
    lines.push(
      agg.ok
        ? checkAggregateRequirements(aggPaths, withPaths, dirs.requirements)
        : {
            name: "aggregate",
            state: "unknown",
            text: `could not ask git for ${from}...HEAD: ${agg.reason}`,
          },
    );
    lines.push(
      agg.ok
        ? checkRangeTests(aggPaths, commits)
        : { name: "tests", state: "unknown", text: `could not ask git for ${from}...HEAD` },
    );
  }

  // The branch and its item.
  const head = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = head.ok ? head.stdout.trim() || null : null;
  lines.push(...checkBranchItems(branch, branch ? itemOfBranch(branch, ids) : null, commits));

  print(lines);
  if (lines.some((l) => l.state === "refused")) return 1;
  if (lines.some((l) => l.state === "unknown")) return allowUnknown ? 0 : 1;
  return 0;
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
