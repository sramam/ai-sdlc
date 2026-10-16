/**
 * `pnpm sdlc:update [--ref <remote/branch>]` — bring the upstream-owned paths
 * up to date with the starter (docs/kit/starter-repo.md § Updating from upstream).
 *
 * It writes the starter's version of those paths into the working tree and
 * shows the diff. It never stages and never commits: what changed is for a
 * person to read, and a project that edited an upstream path in place will see
 * its edit disappear here — which is the point of reviewing it.
 */
import { exec as realExec, firstLine, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { findRoot, loadConfig, upstreamPaths } from "../../core/src/config.mts";

export const UPSTREAM_PATHS = upstreamPaths();

export interface UpdateDeps {
  exec: Exec;
  root: string;
  log: (line: string) => void;
}

export async function runUpdate(
  deps: UpdateDeps,
  ref = "starter/main",
  paths: string[] = UPSTREAM_PATHS,
): Promise<number> {
  const { exec, root, log } = deps;
  const git = (args: string[], timeoutMs = 60_000) => exec("git", args, { cwd: root, timeoutMs });
  const remote = ref.split("/")[0] ?? "starter";

  const status = await git(["status", "--porcelain"]);
  if (status.code !== 0) {
    log(`sdlc:update: could not ask git for the tree's state (${firstLine(status.stderr)})`);
    return 2;
  }
  if (status.stdout.trim()) {
    log(
      "sdlc:update refused: the tree is dirty. Commit or set aside your changes first, so the update's diff is only the update.",
    );
    return 1;
  }

  const url = await git(["remote", "get-url", remote]);
  if (url.code !== 0) {
    log(
      `sdlc:update refused: no \`${remote}\` remote. Add the starter this project was created from:`,
    );
    log(`  git remote add ${remote} https://github.com/<org>/<starter>.git`);
    return 1;
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

  // A path present on neither side would make `git restore` fail the whole call.
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

  // --worktree only: the index is left alone, so nothing is staged. A file the
  // starter deleted is deleted here too, which `git checkout <ref> -- path` would not do.
  const restored = await git(["restore", `--source=${ref}`, "--worktree", "--", ...present]);
  if (restored.code !== 0) {
    log(`sdlc:update: git restore failed: ${firstLine(restored.stderr)}`);
    return 1;
  }

  const stat = await git(["diff", "--stat", "--", ...present]);
  const changed = await git(["status", "--porcelain", "--untracked-files=all", "--", ...present]);
  const lines = changed.stdout.trimEnd().split("\n").filter(Boolean);
  if (lines.length === 0) {
    log("  already current — the upstream-owned paths match the starter");
    return 0;
  }
  log("");
  if (stat.stdout.trim()) log(stat.stdout.trimEnd());
  log("");
  log(`  ${lines.length} path(s) changed (M modified, D deleted upstream, ?? new upstream):`);
  for (const l of lines) log(`    ${l}`);
  log("");
  log(
    "  Review with `git diff` (new files are untracked), then commit with a `No-Item: sdlc:update` trailer.",
  );
  log("  To abandon: git restore -- <paths>, and delete the new files listed with ??.");
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let ref = "starter/main";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ref" && args[i + 1]) ref = args[++i] as string;
    else {
      console.error("usage: pnpm sdlc:update [--ref starter/main]");
      process.exit(1);
    }
  }
  const root = findRoot();
  if (!root) {
    console.error("sdlc:update: no sdlc.config.ts above this directory");
    process.exit(1);
  }
  let paths = UPSTREAM_PATHS;
  try {
    const replaced = (await loadConfig(root)).modules?.replaced ?? [];
    paths = upstreamPaths(replaced);
    if (replaced.length)
      console.log(`  replaced       ${replaced.join(", ")} (the project's own; skipped)`);
  } catch {
    console.log("  config         could not load sdlc.config.ts; updating every upstream path");
  }
  console.log("sdlc:update");
  process.exit(await runUpdate({ exec: realExec, root, log: (l) => console.log(l) }, ref, paths));
}

if (isEntry(import.meta.url)) await main();
