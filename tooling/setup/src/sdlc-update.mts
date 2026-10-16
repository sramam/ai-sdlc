/**
 * `pnpm sdlc:update [--ref <remote/branch>] [--dry-run]` — bring what the
 * starter owns up to date (docs/kit/starter-repo.md § Updating from upstream).
 *
 * What the starter owns, and how each path is updated, is the starter's
 * `starter-manifest.json` (tooling/core/src/manifest.mts), read from the ref:
 *
 *   replace      `git restore --source=<ref> --worktree` — the starter's version
 *   merge-json   merged in-process; never removes a project's addition
 *   merge-lines  missing lines added; never removes one
 *
 * Modules the project replaced (`modules.replaced`) are skipped. The applied
 * starter version is written to `.sdlc-version`, and every section of the
 * starter's docs/kit/MIGRATIONS.md newer than the project's version is printed.
 * A starter whose `minConfigVersion` is above the project's `configVersion` is
 * refused, with the migration that explains the change.
 *
 * It never stages and never commits: what changed is for a person to read, and
 * a project that edited an owned path in place will see its edit disappear —
 * which is the point of reviewing it. A starter with no manifest (older than
 * this file) falls back to restoring the derived upstream paths.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec as realExec, firstLine, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { CONFIG_FILE, findRoot, loadConfig, upstreamPaths } from "../../core/src/config.mts";
import {
  MANIFEST_FILE,
  VERSION_FILE,
  compareVersions,
  isReplacedModule,
  parseManifest,
} from "../../core/src/manifest.mts";
import type { OwnedPath, StarterManifest } from "../../core/src/manifest.mts";
import { mergeJsonText, mergeLines } from "./merge.mts";

export const UPSTREAM_PATHS = upstreamPaths();
export const MIGRATIONS_FILE = "docs/kit/MIGRATIONS.md";

export interface UpdateDeps {
  exec: Exec;
  root: string;
  log: (line: string) => void;
}

export interface UpdateOptions {
  ref: string;
  dryRun: boolean;
  /** `modules.replaced`: the project's own, never touched. */
  replaced: string[];
  /** The project's `configVersion` (default 1). */
  configVersion: number;
}

export type PlanAction = "replace" | "merge" | "unchanged" | "skip" | "n/a";

export interface PlanLine {
  path: string;
  kind: OwnedPath["kind"];
  action: PlanAction;
  detail: string;
  /** For a merge: the text to write. */
  text?: string;
}

/** `## x.y.z` sections of MIGRATIONS.md, oldest first. */
export function migrationSections(text: string): Array<{ version: string; body: string }> {
  const out: Array<{ version: string; body: string }> = [];
  let cur: { version: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = /^##\s+v?(\d+\.\d+\.\d+)\b/.exec(line);
    if (m) {
      if (cur) out.push({ version: cur.version, body: cur.lines.join("\n").trim() });
      cur = { version: m[1] as string, lines: [line] };
    } else if (/^#{1,2}\s/.test(line)) {
      if (cur) out.push({ version: cur.version, body: cur.lines.join("\n").trim() });
      cur = null;
    } else cur?.lines.push(line);
  }
  if (cur) out.push({ version: cur.version, body: cur.lines.join("\n").trim() });
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/** The sections a project at `from` has not seen, up to and including `to`. */
export function newerSections(
  text: string,
  from: string,
  to: string,
): Array<{ version: string; body: string }> {
  return migrationSections(text).filter(
    (s) => compareVersions(s.version, from) > 0 && compareVersions(s.version, to) <= 0,
  );
}

export function readProjectVersion(root: string): string | null {
  const p = join(root, VERSION_FILE);
  if (!existsSync(p)) return null;
  const v = readFileSync(p, "utf8").trim();
  return v || null;
}

export async function runUpdate(deps: UpdateDeps, opts: UpdateOptions): Promise<number> {
  const { exec, root, log } = deps;
  const { ref } = opts;
  const git = (args: string[], timeoutMs = 60_000) => exec("git", args, { cwd: root, timeoutMs });
  const remote = ref.split("/")[0] ?? "starter";

  const status = await git(["status", "--porcelain"]);
  if (status.code !== 0) {
    log(`sdlc:update: could not ask git for the tree's state (${firstLine(status.stderr)})`);
    return 2;
  }
  if (status.stdout.trim()) {
    // A dry run writes nothing, so it may look; applying needs a clean tree.
    if (!opts.dryRun) {
      log(
        "sdlc:update refused: the tree is dirty. Commit or set aside your changes first, so the update's diff is only the update.",
      );
      return 1;
    }
    log("  tree           dirty — fine for a dry run; applying will refuse until it is clean");
  }

  const url = await git(["remote", "get-url", remote]);
  if (url.code !== 0) {
    log(
      `sdlc:update could not ask: no \`${remote}\` remote. Add the starter this project was created from:`,
    );
    log(`  git remote add ${remote} https://github.com/<org>/<starter>.git`);
    return 2;
  }
  log(`  fetch          ${remote} (${url.stdout.trim()})`);
  const fetched = await git(["fetch", "--quiet", remote], 180_000);
  if (fetched.code !== 0) {
    log(`sdlc:update: could not fetch ${remote}: ${firstLine(fetched.stderr)}`);
    return 2;
  }
  const head = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (head.code !== 0) {
    log(`sdlc:update: ${ref} does not exist after fetching`);
    return 1;
  }
  log(`  upstream       ${ref} at ${head.stdout.trim().slice(0, 12)}`);

  /** A file's text at the ref, or null when the ref has no such file. */
  const showAt = async (path: string): Promise<string | null | Error> => {
    const has = await git(["cat-file", "-e", `${ref}:${path}`]);
    if (has.code !== 0) return has.notFound || has.timedOut ? new Error("could not ask git") : null;
    const r = await git(["show", `${ref}:${path}`]);
    return r.code === 0 ? r.stdout : new Error(firstLine(r.stderr) || `git show exited ${r.code}`);
  };

  const manifestText = await showAt(MANIFEST_FILE);
  if (manifestText instanceof Error) {
    log(`sdlc:update: could not read ${MANIFEST_FILE} at ${ref}: ${manifestText.message}`);
    return 2;
  }
  if (manifestText === null) {
    log(`  manifest       none at ${ref}: restoring the derived upstream paths`);
    return legacyRestore(deps, opts);
  }
  let manifest: StarterManifest;
  try {
    manifest = parseManifest(manifestText, `${MANIFEST_FILE} at ${ref}`);
  } catch (e) {
    log(`sdlc:update refused: ${(e as Error).message}`);
    return 1;
  }
  const projectVersion = readProjectVersion(root);
  log(
    `  versions       starter ${manifest.version}; this project ${projectVersion ?? `unknown (no ${VERSION_FILE})`}`,
  );

  const migrations = await showAt(MIGRATIONS_FILE);
  const notes =
    typeof migrations === "string"
      ? newerSections(migrations, projectVersion ?? "0.0.0", manifest.version)
      : [];
  const printNotes = () => {
    if (!notes.length) return;
    log("");
    log(`  Migration notes (${MIGRATIONS_FILE}) since ${projectVersion ?? "the beginning"}:`);
    for (const n of notes) {
      log("");
      for (const l of n.body.split("\n")) log(`    ${l}`.trimEnd());
    }
  };

  const minConfig = manifest.minConfigVersion ?? 1;
  if (minConfig > opts.configVersion) {
    log(
      `sdlc:update refused: the starter needs configVersion ${minConfig} and ${CONFIG_FILE} is at ${opts.configVersion}. Migrate the config first (below), then run it again.`,
    );
    printNotes();
    return 1;
  }

  // The plan, one line per owned path.
  const plan: PlanLine[] = [];
  for (const owned of manifest.owned) {
    const { path, kind } = owned;
    if (isReplacedModule(path, opts.replaced)) {
      plan.push({ path, kind, action: "skip", detail: "replaced by this project" });
      continue;
    }
    if (kind === "replace") {
      const bare = path.replace(/\/$/, "");
      const there = await git(["ls-tree", "--name-only", ref, "--", bare]);
      const here = await git(["ls-files", "--", path]);
      if (!there.stdout.trim() && !here.stdout.trim()) {
        plan.push({ path, kind, action: "n/a", detail: "on neither side" });
        continue;
      }
      const diff = await git(["diff", "--quiet", ref, "--", path]);
      if (diff.code === 0) plan.push({ path, kind, action: "unchanged", detail: "" });
      else if (diff.code === 1) plan.push({ path, kind, action: "replace", detail: "" });
      else {
        log(`sdlc:update: could not compare ${path} (${firstLine(diff.stderr)})`);
        return 2;
      }
      continue;
    }
    const theirs = await showAt(path);
    if (theirs instanceof Error) {
      log(`sdlc:update: could not read ${path} at ${ref}: ${theirs.message}`);
      return 2;
    }
    if (theirs === null) {
      plan.push({ path, kind, action: "n/a", detail: "not in the starter" });
      continue;
    }
    const file = join(root, path);
    const ours = existsSync(file) ? readFileSync(file, "utf8") : null;
    let text: string;
    try {
      text =
        kind === "merge-json" ? mergeJsonText(ours, theirs, owned.keys) : mergeLines(ours, theirs);
    } catch (e) {
      log(`sdlc:update refused: ${path}: ${(e as Error).message}`);
      return 1;
    }
    plan.push(
      text === ours
        ? { path, kind, action: "unchanged", detail: "" }
        : { path, kind, action: "merge", detail: ours === null ? "new" : "", text },
    );
  }

  log("");
  for (const p of plan)
    log(
      `  ${p.action.padEnd(10)} ${p.kind.padEnd(12)} ${p.path}${p.detail ? `  (${p.detail})` : ""}`,
    );
  const toReplace = plan.filter((p) => p.action === "replace").map((p) => p.path);
  const toMerge = plan.filter((p) => p.action === "merge");
  const bump = projectVersion !== manifest.version;

  if (opts.dryRun) {
    log("");
    log(
      `  dry run: ${toReplace.length} to replace, ${toMerge.length} to merge${bump ? `, ${VERSION_FILE} ${projectVersion ?? "(none)"} → ${manifest.version}` : ""}; nothing written`,
    );
    printNotes();
    return 0;
  }

  if (toReplace.length) {
    // --worktree only: the index is left alone, so nothing is staged. A file
    // the starter deleted is deleted here too.
    const restored = await git(["restore", `--source=${ref}`, "--worktree", "--", ...toReplace]);
    if (restored.code !== 0) {
      log(`sdlc:update: git restore failed: ${firstLine(restored.stderr)}`);
      return 1;
    }
  }
  for (const m of toMerge) {
    const file = join(root, m.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, m.text as string);
  }
  if (bump) writeFileSync(join(root, VERSION_FILE), `${manifest.version}\n`);

  const touched = [...toReplace, ...toMerge.map((m) => m.path), ...(bump ? [VERSION_FILE] : [])];
  if (touched.length === 0) {
    log("");
    log(`  already current at ${manifest.version} — every owned path matches the starter`);
    return 0;
  }
  const stat = await git(["diff", "--stat", "--", ...touched]);
  const changed = await git(["status", "--porcelain", "--untracked-files=all", "--", ...touched]);
  const lines = changed.stdout.trimEnd().split("\n").filter(Boolean);
  log("");
  if (stat.stdout.trim()) log(stat.stdout.trimEnd());
  log("");
  log(`  ${lines.length} path(s) changed (M modified, D deleted upstream, ?? new upstream):`);
  for (const l of lines) log(`    ${l}`);
  if (toMerge.some((m) => m.path === "package.json"))
    log("  package.json changed: run `pnpm install` before anything else.");
  printNotes();
  log("");
  log(
    "  Review with `git diff` (new files are untracked), then commit with a `No-Item: sdlc:update` trailer.",
  );
  log("  To abandon: git restore -- <paths>, and delete the new files listed with ??.");
  return 0;
}

/** A starter from before the manifest: restore the derived upstream paths, as before. */
async function legacyRestore(deps: UpdateDeps, opts: UpdateOptions): Promise<number> {
  const { exec, root, log } = deps;
  const { ref } = opts;
  const git = (args: string[]) => exec("git", args, { cwd: root, timeoutMs: 60_000 });
  const paths = upstreamPaths(opts.replaced);
  const present: string[] = [];
  for (const p of paths) {
    const there = await git(["ls-tree", "--name-only", ref, "--", p.replace(/\/$/, "")]);
    const here = await git(["ls-files", "--", p]);
    if (there.stdout.trim() || here.stdout.trim()) present.push(p);
    else log(`  n/a            ${p} (on neither side)`);
  }
  if (present.length === 0) {
    log("  nothing to update");
    return 0;
  }
  if (opts.dryRun) {
    for (const p of present) log(`  replace    ${p}`);
    log("  dry run: nothing written");
    return 0;
  }
  const restored = await git(["restore", `--source=${ref}`, "--worktree", "--", ...present]);
  if (restored.code !== 0) {
    log(`sdlc:update: git restore failed: ${firstLine(restored.stderr)}`);
    return 1;
  }
  const changed = await git(["status", "--porcelain", "--untracked-files=all", "--", ...present]);
  const lines = changed.stdout.trimEnd().split("\n").filter(Boolean);
  if (lines.length === 0) {
    log("  already current — the upstream-owned paths match the starter");
    return 0;
  }
  log(`  ${lines.length} path(s) changed:`);
  for (const l of lines) log(`    ${l}`);
  log("  Review with `git diff`, then commit with a `No-Item: sdlc:update` trailer.");
  return 0;
}

const USAGE = "usage: pnpm sdlc:update [--ref starter/main] [--dry-run]";

export function parseArgs(argv: string[]): { ref: string; dryRun: boolean } | { error: string } {
  let ref = "starter/main";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref" && argv[i + 1]) ref = argv[++i] as string;
    else if (a === "--dry-run") dryRun = true;
    else return { error: USAGE };
  }
  return { ref, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error(`sdlc:update: no ${CONFIG_FILE} above this directory`);
    process.exit(1);
  }
  console.log(`sdlc:update${args.dryRun ? " (dry run)" : ""}`);
  // Which modules are the project's own is read from its config. A config that
  // does not load cannot answer that, and guessing "none" would overwrite a
  // replaced module — so it refuses rather than updating everything.
  let replaced: string[];
  let configVersion: number;
  try {
    const config = await loadConfig(root);
    replaced = config.modules?.replaced ?? [];
    configVersion = config.configVersion ?? 1;
  } catch (e) {
    console.error(`sdlc:update refused: ${(e as Error).message}`);
    process.exit(1);
  }
  if (replaced.length)
    console.log(`  replaced       ${replaced.join(", ")} (the project's own; skipped)`);
  process.exit(
    await runUpdate(
      { exec: realExec, root, log: (l) => console.log(l) },
      { ref: args.ref, dryRun: args.dryRun, replaced, configVersion },
    ),
  );
}

if (isEntry(import.meta.url)) await main();
