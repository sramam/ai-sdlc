/**
 * `pnpm release [--minor|--major|--patch] [--at <ref>] [--yes] [--allow-unknown]`
 * — give a commit on origin/<integration> a version, so a build has a name
 * rather than a date.
 *
 *   no bump flag        report: the latest version, what is unreleased, the verdict
 *   a bump flag         plan: the tag, the range and the notes; writes nothing
 *   a bump flag --yes   create the annotated tag locally and print the push
 *                       command. It never pushes, and bumps no package.json
 *
 * Refuses a dirty tree, a commit not on origin/<integration>, a tag that
 * exists, a version that is not an increase (including a newer version on an
 * older commit), and a `local-ci` status that is not success. Red has no
 * override. Unknown — absent, pending, error, only the allow-unknown override,
 * or GitHub unreachable — is overridden by --allow-unknown, which writes into
 * the tag annotation that nobody checked.
 *
 * The notes are the `Progress:`, `Closes:` and `No-Item:` trailers in the range
 * since the previous version on this commit's history, grouped by item. Nothing
 * is summarised.
 *
 * A version says which code. It never says which journeys are testable.
 *
 * Exit 0 reported, planned or tagged · 1 refused · 2 could not ask.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { findRoot, loadConfig as realLoadConfig } from "../../core/src/config.mts";
import type { SdlcConfig } from "../../core/src/config.mts";
import { exitFor, localCiVerdict, reporter, shortSha, why } from "./shared.mts";
import type { LineState } from "./shared.mts";

export type Bump = "major" | "minor" | "patch";

export interface ReleaseOptions {
  bump?: Bump;
  at?: string;
  yes: boolean;
  allowUnknown: boolean;
}

export interface ReleaseDeps {
  exec: Exec;
  root: string;
  loadConfig: (dir: string) => Promise<SdlcConfig>;
  log: (line: string) => void;
  /** A fresh directory for the tag message. */
  tempDir: () => string;
  now: () => Date;
}

export interface ReleaseOutcome {
  exit: number;
  stoppedAt?: string;
  tag?: string;
  sha?: string;
  notes?: string;
  tagged: boolean;
}

export type Version = [number, number, number];

const USAGE =
  "usage: pnpm release [--minor|--major|--patch] [--at <ref>] [--yes] [--allow-unknown]";

export function parseReleaseArgs(argv: string[]): ReleaseOptions | { error: string } {
  const opts: ReleaseOptions = { yes: false, allowUnknown: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--major" || a === "--minor" || a === "--patch") {
      const b = a.slice(2) as Bump;
      if (opts.bump && opts.bump !== b)
        return { error: `choose one of --major, --minor, --patch\n${USAGE}` };
      opts.bump = b;
    } else if (a === "--yes") opts.yes = true;
    else if (a === "--allow-unknown") opts.allowUnknown = true;
    else if (a === "--at") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `--at needs a ref\n${USAGE}` };
      opts.at = v;
    } else return { error: `unknown argument: ${a}\n${USAGE}` };
  }
  if (opts.yes && !opts.bump)
    return { error: `--yes needs a bump: --major, --minor or --patch\n${USAGE}` };
  return opts;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The version a tag names under `prefix`, or null for any other tag. */
export function parseTag(tag: string, prefix: string): Version | null {
  const m = new RegExp(`^${escapeRe(prefix)}(\\d+)\\.(\\d+)\\.(\\d+)$`).exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export const compareVersions = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const formatVersion = (v: Version): string => v.join(".");

export function bumpVersion(v: Version, bump: Bump): Version {
  if (bump === "major") return [v[0] + 1, 0, 0];
  if (bump === "minor") return [v[0], v[1] + 1, 0];
  return [v[0], v[1], v[2] + 1];
}

/** The highest version among `git tag --list` output, with its tag. */
export function latestTag(
  listing: string,
  prefix: string,
): { tag: string; version: Version } | null {
  let best: { tag: string; version: Version } | null = null;
  for (const tag of listing.split("\n").map((t) => t.trim())) {
    const version = parseTag(tag, prefix);
    if (version && (!best || compareVersions(version, best.version) > 0)) best = { tag, version };
  }
  return best;
}

export interface ReleaseCommit {
  sha: string;
  subject: string;
  merge: boolean;
  progress: string[];
  closes: string[];
  noItem: string[];
}

/** `git log --format=%H%x1f%P%x1f%s%x1f%(trailers:only,unfold)%x1e` output. */
export function parseReleaseLog(out: string): ReleaseCommit[] {
  const commits: ReleaseCommit[] = [];
  for (const rec of out.split("\x1e")) {
    const [sha, parents, subject, trailers] = rec.replace(/^\n+/, "").split("\x1f");
    if (!sha?.trim()) continue;
    const c: ReleaseCommit = {
      sha: sha.trim(),
      subject: (subject ?? "").trim(),
      merge: (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1,
      progress: [],
      closes: [],
      noItem: [],
    };
    for (const line of (trailers ?? "").split("\n")) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
      if (!m || !m[1] || !m[2]) continue;
      const key = m[1].toLowerCase();
      if (key === "progress") c.progress.push(m[2].trim());
      else if (key === "closes") c.closes.push(...m[2].split(/[\s,]+/).filter(Boolean));
      else if (key === "no-item") c.noItem.push(m[2].trim());
    }
    commits.push(c);
  }
  return commits;
}

const ITEM_ID = /^[A-Za-z][A-Za-z0-9]*-\d+[A-Za-z0-9]*$/;

/** The notes: trailers grouped by item, in first-seen order. */
export function releaseNotes(
  commits: ReleaseCommit[],
  head: { tag: string; sha: string; integration: string; previous: string | null; date: string },
  unchecked?: string,
): string {
  const items = new Map<string, { lines: string[]; closed: boolean }>();
  const item = (id: string) => {
    let g = items.get(id);
    if (!g) items.set(id, (g = { lines: [], closed: false }));
    return g;
  };
  const noItem: string[] = [];
  let described = 0;
  let merges = 0;
  let bare = 0;
  for (const c of commits) {
    const s = c.sha.slice(0, 7);
    if (c.progress.length || c.closes.length || c.noItem.length) described++;
    else if (c.merge) merges++;
    else bare++;
    for (const p of c.progress) {
      const [first, ...rest] = p.split(/\s+/);
      if (first && ITEM_ID.test(first))
        item(first).lines.push(`${rest.join(" ") || "(no description)"} (${s})`);
      else item("(no item ID)").lines.push(`${p} (${s})`);
    }
    for (const id of c.closes) item(id).closed = true;
    for (const n of c.noItem) noItem.push(`${n} (${s})`);
  }
  const out = [
    `${head.tag} — ${head.sha.slice(0, 12)} on ${head.integration}, ${head.date}`,
    `${commits.length} commit(s) since ${head.previous ?? "the first commit"}: ${described} described, ${merges} merge(s), ${bare} with no Progress:/Closes:/No-Item:`,
  ];
  if (unchecked)
    out.push("", `local-ci: NOT CHECKED — released with --allow-unknown (${unchecked})`);
  for (const [id, g] of items) {
    out.push("", `${id}${g.closed ? " — closed" : ""}`);
    for (const l of g.lines) out.push(`  - ${l}`);
    if (!g.lines.length) out.push("  - (closed with no Progress: line in this range)");
  }
  if (noItem.length) {
    out.push("", "No item");
    for (const l of noItem) out.push(`  - ${l}`);
  }
  return `${out.join("\n")}\n`;
}

export async function runRelease(opts: ReleaseOptions, deps: ReleaseDeps): Promise<ReleaseOutcome> {
  const { log, root } = deps;
  const line = reporter(log);
  let sha: string | undefined;
  let tag: string | undefined = undefined;
  const stop = (name: string, state: LineState, text: string): ReleaseOutcome => {
    line(name, state, text);
    log("");
    log(`release: stopped at ${name}. No tag was created.`);
    return { exit: exitFor(state), stoppedAt: name, sha, tag, tagged: false };
  };
  const git = (args: string[], timeoutMs = 60_000) =>
    deps.exec("git", args, { cwd: root, timeoutMs });

  const config = await deps.loadConfig(root);
  const integration = config.branches.integration;
  const prefix = config.release?.tagPrefix ?? "v";
  log(`release on origin/${integration}${opts.bump ? ` (--${opts.bump})` : " (report)"}`);

  // 1. Clean.
  const st = await git(["status", "--porcelain"]);
  if (st.code !== 0) return stop("clean", "COULD NOT ASK", `git status: ${why(st)}`);
  if (st.stdout.trim())
    return stop("clean", "REFUSED", "the tree is dirty — a release names a commit, not a desk");
  line("clean", "ok", "nothing uncommitted");

  // 2. Fetch, tags included: tags are global, and a name given elsewhere counts.
  const f = await git(["fetch", "--quiet", "--tags", "origin"], 300_000);
  if (f.code !== 0) return stop("fetch", "COULD NOT ASK", `git fetch --tags: ${why(f)}`);
  line("fetch", "ok", "origin, with tags");

  // 3. The commit.
  const tipR = await git(["rev-parse", "--verify", "--quiet", `origin/${integration}^{commit}`]);
  if (tipR.notFound || tipR.timedOut) return stop("commit", "COULD NOT ASK", `git: ${why(tipR)}`);
  if (tipR.code !== 0 || !tipR.stdout.trim())
    return stop("commit", "REFUSED", `origin/${integration} not found`);
  const tip = tipR.stdout.trim();
  if (opts.at) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${opts.at}^{commit}`]);
    if (r.code !== 0 || !r.stdout.trim())
      return stop("commit", "REFUSED", `--at ${opts.at} does not resolve to a commit`);
    sha = r.stdout.trim();
    if (sha !== tip) {
      const on = await git(["merge-base", "--is-ancestor", sha, tip]);
      if (on.code === 1)
        return stop(
          "commit",
          "REFUSED",
          `${shortSha(sha)} is not on origin/${integration} — a name for unreviewed work is worse than no name`,
        );
      if (on.code !== 0) return stop("commit", "COULD NOT ASK", `git merge-base: ${why(on)}`);
    }
  } else sha = tip;
  line(
    "commit",
    "ok",
    sha === tip
      ? `origin/${integration} at ${shortSha(sha)}`
      : `${shortSha(sha)}, on origin/${integration}`,
  );

  // 4. Versions: the highest anywhere, and the previous one on this history.
  const all = await git(["tag", "--list", `${prefix}*`]);
  const merged = await git(["tag", "--list", "--merged", sha, `${prefix}*`]);
  if (all.code !== 0 || merged.code !== 0)
    return stop(
      "versions",
      "COULD NOT ASK",
      `git tag --list: ${why(all.code !== 0 ? all : merged)}`,
    );
  const latest = latestTag(all.stdout, prefix);
  const previous = latestTag(merged.stdout, prefix);
  const range = previous ? `${previous.tag}..${sha}` : sha;
  const countR = await git(["rev-list", "--count", range]);
  const unreleased = countR.code === 0 ? countR.stdout.trim() : "?";
  line(
    "versions",
    "ok",
    `latest ${latest ? latest.tag : "(none)"}; ${unreleased} commit(s) since ${previous ? previous.tag : "the first commit"}`,
  );

  // 5. CI.
  const ci = await localCiVerdict(deps.exec, root, sha);
  if (!opts.bump) {
    line("local-ci", ci.verdict === "green" ? "ok" : "warn", `${ci.verdict}: ${ci.detail}`);
    log("");
    log(
      `release: report only. ${unreleased} commit(s) unreleased. Plan one with --patch, --minor or --major.`,
    );
    return { exit: 0, sha, tagged: false };
  }
  let unchecked: string | undefined;
  if (ci.verdict === "red")
    return stop("local-ci", "REFUSED", `${ci.detail} — there is no override for red`);
  if (ci.verdict === "unknown") {
    if (!opts.allowUnknown)
      return stop(
        "local-ci",
        ci.couldNotAsk ? "COULD NOT ASK" : "REFUSED",
        `${ci.detail}. --allow-unknown overrides and writes into the tag that nobody checked`,
      );
    unchecked = ci.detail;
    line("local-ci", "warn", `ALLOWED UNKNOWN: ${ci.detail}`);
  } else line("local-ci", "ok", ci.detail);

  // 6. The version: an increase, on a history that contains the latest.
  const base: Version = latest?.version ?? [0, 0, 0];
  const next = bumpVersion(base, opts.bump);
  tag = `${prefix}${formatVersion(next)}`;
  if (latest && compareVersions(next, latest.version) <= 0)
    return stop("version", "REFUSED", `${tag} is not an increase on ${latest.tag}`);
  if (latest) {
    const lr = await git(["rev-parse", "--verify", "--quiet", `refs/tags/${latest.tag}^{commit}`]);
    if (lr.code !== 0)
      return stop("version", "COULD NOT ASK", `git rev-parse ${latest.tag}: ${why(lr)}`);
    const latestSha = lr.stdout.trim();
    if (latestSha === sha)
      return stop("version", "REFUSED", `${shortSha(sha)} is already ${latest.tag}`);
    const anc = await git(["merge-base", "--is-ancestor", latestSha, sha]);
    if (anc.code === 1)
      return stop(
        "version",
        "REFUSED",
        `${latest.tag} (${shortSha(latestSha)}) is not in ${shortSha(sha)}'s history — ${tag} would name older code than ${latest.tag}`,
      );
    if (anc.code !== 0) return stop("version", "COULD NOT ASK", `git merge-base: ${why(anc)}`);
  }
  line("version", "ok", `${latest ? latest.tag : "(none)"} → ${tag}`);

  // 7. The tag must not exist.
  const ex = await git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
  if (ex.code === 0)
    return stop(
      "tag",
      "REFUSED",
      `${tag} exists — tags are global; re-pointing one changes what a name already means`,
    );
  if (ex.notFound || ex.timedOut) return stop("tag", "COULD NOT ASK", `git: ${why(ex)}`);
  line("tag", "ok", `${tag} is free`);

  // 8. Notes.
  const logR = await git(["log", "--format=%H%x1f%P%x1f%s%x1f%(trailers:only,unfold)%x1e", range]);
  if (logR.code !== 0) return stop("notes", "COULD NOT ASK", `git log: ${why(logR)}`);
  const commits = parseReleaseLog(logR.stdout);
  const notes = releaseNotes(
    commits,
    {
      tag,
      sha,
      integration,
      previous: previous?.tag ?? null,
      date: deps.now().toISOString().slice(0, 10),
    },
    unchecked,
  );
  line(
    "notes",
    "ok",
    `${commits.length} commit(s) in ${previous ? `${previous.tag}..` : ""}${shortSha(sha)}`,
  );
  log("");
  for (const l of notes.trimEnd().split("\n")) log(`    | ${l}`);
  log("");

  if (!opts.yes) {
    log(
      `release: plan only — nothing written. Once a person agrees: pnpm release --${opts.bump}${opts.at ? ` --at ${opts.at}` : ""}${opts.allowUnknown ? " --allow-unknown" : ""} --yes`,
    );
    return { exit: 0, sha, tag, notes, tagged: false };
  }

  // 9. Tag, locally. Never pushed here.
  const dir = deps.tempDir();
  try {
    const file = join(dir, "tag-message.txt");
    writeFileSync(file, notes);
    const t = await git(["tag", "--annotate", tag, sha, "--file", file]);
    if (t.code !== 0)
      return stop(
        "create",
        t.notFound || t.timedOut ? "COULD NOT ASK" : "FAILED",
        `git tag: ${why(t)}`,
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  line("create", "ok", `annotated ${tag} at ${shortSha(sha)} (local only)`);
  log("");
  log(`release: ${tag} created locally. Nothing was pushed and no package.json changed.`);
  log(`  to publish it: git push origin refs/tags/${tag}`);
  return { exit: 0, sha, tag, notes, tagged: true };
}

async function main(): Promise<void> {
  const opts = parseReleaseArgs(process.argv.slice(2));
  if ("error" in opts) {
    console.error(opts.error);
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error("release: no sdlc.config.json above this directory");
    process.exit(1);
  }
  const outcome = await runRelease(opts, {
    exec: realExec,
    root,
    loadConfig: realLoadConfig,
    log: (l) => console.log(l),
    tempDir: () => mkdtempSync(join(tmpdir(), "release-")),
    now: () => new Date(),
  });
  process.exit(outcome.exit);
}

if (isEntry(import.meta.url)) await main();
