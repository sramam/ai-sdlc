/**
 * `pnpm land [--allow-unknown]` — landing, performed deterministically.
 *
 * The procedure (.agents/skills/git-workflow-and-versioning/landing.md) is the
 * judgement; this is the
 * remembering. An agent runs this one command and needs no permission to
 * push to, merge into or force anything by hand. Every step prints one line.
 *
 *   1. branch     refuse the integration/staging/production branch, a detached HEAD
 *   2. clean      refuse a dirty tree
 *   3. fetch      git fetch origin
 *   4. current    refuse unless origin/<integration> is an ancestor of HEAD
 *   5. trailers   a Progress: or No-Item: across origin/<integration>..HEAD
 *                 (tooling/guards trailers --range, run as a child process)
 *   6. requirements  a branch touching docs/requirements/ touches nothing else,
 *                 unless it is the x-000-* discovery branch
 *   7. push       git push -u origin HEAD — never forced
 *   8. ci         ci:local on the pushed SHA; on red, stop
 *   9. pr         find the open PR into <integration>, or create one whose body
 *                 lists the branch's Progress/Closes/No-Item lines
 *  10. recheck    PR open, still into <integration>, head == the tested SHA,
 *                 origin/<integration> unmoved; else stop
 *  11. merge      gh pr merge --merge --match-head-commit <tested SHA> (never
 *                 squash; GitHub refuses if the head moved after the recheck),
 *                 --delete-branch only with Closes:
 *  12. dev-status fetch, then ci:local --sha origin/<integration>: the merge
 *                 commit's tree is the tree just tested, so its content checks
 *                 are a cache hit and only the history checks run
 *
 * Exit 0 landed · 1 refused or failed · 2 could not ask (git, gh, the network).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec, firstLine, isEntry } from "../../core/src/exec.mts";
import type { Exec, ExecResult } from "../../core/src/exec.mts";
import { findRoot, loadConfig as realLoadConfig } from "../../core/src/config.mts";
import type { SdlcConfig } from "../../core/src/config.mts";
import { realCiDeps, runCiLocal } from "./ci-local.mts";
import type { CiOptions, CiOutcome } from "./ci-local.mts";

export interface LandOptions {
  allowUnknown: boolean;
}

export type CiResult = Pick<CiOutcome, "exit" | "verdict" | "status"> &
  Partial<Pick<CiOutcome, "context" | "reused">>;

export interface LandDeps {
  exec: Exec;
  root: string;
  loadConfig: (dir: string) => Promise<SdlcConfig>;
  log: (line: string) => void;
  /** ci:local, in-process by default. */
  runCi: (opts: CiOptions) => Promise<CiResult>;
  /** A fresh directory for the generated PR body. */
  tempDir: () => string;
}

export interface LandOutcome {
  exit: number;
  /** The step that stopped the run, when one did. */
  stoppedAt?: string;
  pr?: number;
  merged: boolean;
  mergeSha?: string;
}

type LineState = "ok" | "REFUSED" | "FAILED" | "COULD NOT ASK" | "warn";

const USAGE = "usage: pnpm land [--allow-unknown]";

export function parseLandArgs(argv: string[]): LandOptions | { error: string } {
  const opts: LandOptions = { allowUnknown: false };
  for (const a of argv) {
    if (a === "--allow-unknown") opts.allowUnknown = true;
    else return { error: `unknown argument: ${a}\n${USAGE}` };
  }
  return opts;
}

/** Trailers of every commit in a range, as `git log` parses them. */
export interface RangeTrailers {
  subjects: string[];
  progress: string[];
  closes: string[];
  noItem: string[];
}

export function parseRangeTrailers(logOutput: string): RangeTrailers {
  const out: RangeTrailers = { subjects: [], progress: [], closes: [], noItem: [] };
  for (const rec of logOutput.split("\x1e")) {
    const [subject, trailers] = rec.replace(/^\n+/, "").split("\x1f");
    if (subject === undefined || !subject.trim()) continue;
    out.subjects.push(subject.trim());
    for (const line of (trailers ?? "").split("\n")) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
      if (!m || !m[1] || !m[2]) continue;
      const key = m[1].toLowerCase();
      if (key === "progress") out.progress.push(m[2]);
      else if (key === "closes") out.closes.push(m[2]);
      else if (key === "no-item") out.noItem.push(m[2]);
    }
  }
  return out;
}

export function prBody(t: RangeTrailers, integration: string): string {
  const lines = [
    `Landed by \`pnpm land\` into \`${integration}\` as a merge commit.`,
    "",
    ...t.progress.map((v) => `Progress: ${v}`),
    ...t.closes.map((v) => `Closes: ${v}`),
    ...t.noItem.map((v) => `No-Item: ${v}`),
    "",
    "Commits:",
    ...t.subjects.map((s) => `- ${s}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** The discovery branch (`x-000-…`) lands requirements with everything decided alongside them. */
export function isDiscoveryBranch(branch: string): boolean {
  return /^x-000(-|$)/i.test(branch);
}

export async function runLand(opts: LandOptions, deps: LandDeps): Promise<LandOutcome> {
  const { log, root } = deps;
  const line = (name: string, state: LineState, text: string) =>
    log(`  ${state.padEnd(13)} ${name.padEnd(13)} ${text}`);
  const stop = (name: string, state: LineState, text: string, extra: Partial<LandOutcome> = {}) => {
    line(name, state, text);
    const exit = state === "COULD NOT ASK" ? 2 : 1;
    log("");
    log(`land: stopped at ${name}. Nothing after it ran${extra.merged ? "" : "; nothing merged"}.`);
    return { exit, stoppedAt: name, merged: false, ...extra };
  };
  const git = (args: string[], timeoutMs = 60_000) =>
    deps.exec("git", args, { cwd: root, timeoutMs });
  const ghEnv = { ...process.env, GH_PROMPT_DISABLED: "1" };
  const gh = (args: string[]) =>
    deps.exec("gh", args, { cwd: root, timeoutMs: 120_000, env: ghEnv });
  const why = (r: ExecResult) =>
    r.notFound ? "not installed" : r.timedOut ? "timed out" : firstLine(r.stderr || r.stdout, 120);

  const config = await deps.loadConfig(root);
  const integration = config.branches.integration;
  const protectedBranches = [integration, config.branches.staging, config.branches.production];
  log(`land → ${integration}`);

  // 1. Branch.
  const br = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (br.notFound || br.timedOut) return stop("branch", "COULD NOT ASK", `git: ${why(br)}`);
  if (br.code !== 0) return stop("branch", "REFUSED", "HEAD is detached — land a named branch");
  const branch = br.stdout.trim();
  if (protectedBranches.includes(branch))
    return stop(
      "branch",
      "REFUSED",
      `on ${branch} — land a feature branch, never ${branch} itself`,
    );
  line("branch", "ok", branch);

  // 2. Clean.
  const st = await git(["status", "--porcelain"]);
  if (st.code !== 0) return stop("clean", "COULD NOT ASK", `git status: ${why(st)}`);
  if (st.stdout.trim()) {
    const dirty = st.stdout.trimEnd().split("\n");
    return stop(
      "clean",
      "REFUSED",
      `the tree is dirty (${dirty.length} path(s), e.g. ${dirty[0]?.trim()}) — commit or remove first`,
    );
  }
  line("clean", "ok", "nothing uncommitted");

  // 3. Fetch.
  const f = await git(["fetch", "--quiet", "origin"], 300_000);
  if (f.code !== 0) return stop("fetch", "COULD NOT ASK", `git fetch: ${why(f)}`);
  line("fetch", "ok", "origin");

  // 4. Current.
  const baseR = await git(["rev-parse", "--verify", "--quiet", `origin/${integration}^{commit}`]);
  if (baseR.code !== 0 || !baseR.stdout.trim())
    return stop("current", "REFUSED", `origin/${integration} not found`);
  const baseSha = baseR.stdout.trim();
  const headR = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headR.code !== 0)
    return stop("current", "COULD NOT ASK", `git rev-parse HEAD: ${why(headR)}`);
  const headSha = headR.stdout.trim();
  const anc = await git(["merge-base", "--is-ancestor", baseSha, headSha]);
  if (anc.code === 1)
    return stop(
      "current",
      "REFUSED",
      `HEAD does not contain origin/${integration} — \`git merge origin/${integration}\` first, verify any resolved conflict by substance, then re-run`,
    );
  if (anc.code !== 0) return stop("current", "COULD NOT ASK", `git merge-base: ${why(anc)}`);
  if (baseSha === headSha)
    return stop("current", "REFUSED", `HEAD is origin/${integration} — nothing to land`);
  line("current", "ok", `contains origin/${integration} (${baseSha.slice(0, 12)})`);

  // 5. Trailers — the guard's own check, so land and ci:local cannot disagree.
  // Run as a child: its range mode reads git and prints directly, so it is not
  // injectable in-process.
  const range = `origin/${integration}`;
  const tr = await deps.exec("node", ["tooling/guards/src/trailers.mts", "--range", range], {
    cwd: root,
    timeoutMs: 120_000,
  });
  if (tr.notFound || tr.timedOut) return stop("trailers", "COULD NOT ASK", `node: ${why(tr)}`);
  if (tr.code !== 0) {
    const said = (tr.stdout + tr.stderr).trimEnd();
    if (said) log(said.replace(/^/gm, "      | "));
    return stop(
      "trailers",
      "REFUSED",
      `${range}..HEAD needs a Progress: <ITEM-ID> or No-Item: <reason> trailer, and every ID must name an item (docs/kit/hooks.md)`,
    );
  }
  const logR = await git([
    "log",
    "--reverse",
    "--format=%s%x1f%(trailers:only,unfold)%x1e",
    `${range}..HEAD`,
  ]);
  if (logR.code !== 0) return stop("trailers", "COULD NOT ASK", `git log: ${why(logR)}`);
  const trailers = parseRangeTrailers(logR.stdout);
  line(
    "trailers",
    "ok",
    `${trailers.progress.length} Progress, ${trailers.closes.length} Closes, ${trailers.noItem.length} No-Item`,
  );

  // 6. Requirements stand alone, except on the discovery branch.
  const diff = await git(["diff", "--name-only", "-z", `${range}...HEAD`]);
  if (diff.code !== 0) return stop("requirements", "COULD NOT ASK", `git diff: ${why(diff)}`);
  const paths = diff.stdout.split("\0").filter(Boolean);
  const reqDir = `${config.dirs.requirements.replace(/\/+$/, "")}/`;
  const req = paths.filter((p) => p.startsWith(reqDir));
  if (req.length && !isDiscoveryBranch(branch)) {
    const other = paths.filter((p) => !p.startsWith(reqDir));
    if (other.length)
      return stop(
        "requirements",
        "REFUSED",
        `touches ${reqDir} and ${other.length} other path(s) (e.g. ${other.slice(0, 3).join(", ")}). A requirements change is its own branch and PR, landed first`,
      );
  }
  line(
    "requirements",
    "ok",
    req.length
      ? isDiscoveryBranch(branch)
        ? `${req.length} requirement path(s), on the discovery branch`
        : `${req.length} requirement path(s), and nothing else`
      : `no change under ${reqDir}`,
  );

  // 7. Push. GitHub must have the SHA before a status can be posted on it.
  const push = await git(["push", "-u", "origin", "HEAD"], 300_000);
  if (push.code !== 0)
    return stop(
      "push",
      push.notFound || push.timedOut ? "COULD NOT ASK" : "FAILED",
      `git push: ${why(push)}`,
    );
  line("push", "ok", `${branch} @ ${headSha.slice(0, 12)}`);

  // 8. CI on the pushed SHA.
  const ci = await deps.runCi({ sha: headSha, allowUnknown: opts.allowUnknown, noStatus: false });
  if (ci.exit !== 0 || ci.verdict === null)
    return stop(
      "ci",
      ci.exit === 2 ? "COULD NOT ASK" : "FAILED",
      `ci:local ${ci.verdict ?? "refused"} on ${headSha.slice(0, 12)} (exit ${ci.exit}) — read its output above`,
    );
  if (ci.status !== "posted")
    return stop("ci", "COULD NOT ASK", `ci:local passed but posted no status (${ci.status})`);
  const override = ci.verdict !== "pass";
  line(
    "ci",
    override ? "warn" : "ok",
    override
      ? `ALLOWED UNKNOWN on ${headSha.slice(0, 12)} — posted ${ci.context ?? "local-ci/allow-unknown"}, not local-ci`
      : `pass on ${headSha.slice(0, 12)}${ci.reused ? " (content checks reused)" : ""}`,
  );

  // 9. The PR.
  const view = await gh(["pr", "view", "--json", "number,headRefOid,state,baseRefName"]);
  let pr: number | undefined;
  if (view.code === 0) {
    try {
      const v = JSON.parse(view.stdout) as { number: number; state: string; baseRefName: string };
      if (v.state === "OPEN") {
        if (v.baseRefName !== integration)
          return stop("pr", "REFUSED", `#${v.number} targets ${v.baseRefName}, not ${integration}`);
        pr = v.number;
        line("pr", "ok", `#${pr} (existing)`);
      }
    } catch {
      return stop("pr", "COULD NOT ASK", `gh pr view returned unreadable JSON`);
    }
  } else if (
    view.notFound ||
    view.timedOut ||
    !/no (open )?pull requests? found/i.test(view.stderr + view.stdout)
  ) {
    return stop("pr", "COULD NOT ASK", `gh pr view: ${why(view)}`);
  }
  if (pr === undefined) {
    const dir = deps.tempDir();
    const bodyFile = join(dir, "pr-body.md");
    writeFileSync(bodyFile, prBody(trailers, integration));
    const title = trailers.subjects.length === 1 ? (trailers.subjects[0] ?? branch) : branch;
    const create = await gh([
      "pr",
      "create",
      "--base",
      integration,
      "--head",
      branch,
      "--title",
      title,
      "--body-file",
      bodyFile,
    ]);
    rmSync(dir, { recursive: true, force: true });
    if (create.code !== 0) return stop("pr", "FAILED", `gh pr create: ${why(create)}`);
    const m = /\/pull\/(\d+)/.exec(create.stdout);
    if (!m || !m[1]) return stop("pr", "COULD NOT ASK", `gh pr create printed no PR URL`);
    pr = Number(m[1]);
    line("pr", "ok", `#${pr} (created into ${integration})`);
  }

  // 10. Re-check: nothing moved between the test and the merge.
  const again = await gh(["pr", "view", String(pr), "--json", "headRefOid,state,baseRefName"]);
  if (again.code !== 0)
    return stop("recheck", "COULD NOT ASK", `gh pr view ${pr}: ${why(again)}`, { pr });
  let head: { headRefOid?: string; state?: string; baseRefName?: string };
  try {
    head = JSON.parse(again.stdout) as typeof head;
  } catch {
    return stop("recheck", "COULD NOT ASK", `gh pr view ${pr} returned unreadable JSON`, { pr });
  }
  if (head.state !== "OPEN")
    return stop("recheck", "REFUSED", `#${pr} is ${head.state ?? "unknown"}, not open`, { pr });
  // Retargeted after it was found or created: merging would land on another branch.
  if (head.baseRefName !== integration)
    return stop(
      "recheck",
      "REFUSED",
      `#${pr} now targets ${head.baseRefName ?? "an unreadable base"}, not ${integration} — retarget it to ${integration} and re-run land`,
      { pr },
    );
  if (head.headRefOid !== headSha)
    return stop(
      "recheck",
      "REFUSED",
      `#${pr} head is ${String(head.headRefOid).slice(0, 12)}, not the tested ${headSha.slice(0, 12)} — re-run land`,
      { pr },
    );
  const f2 = await git(["fetch", "--quiet", "origin"], 300_000);
  if (f2.code !== 0) return stop("recheck", "COULD NOT ASK", `git fetch: ${why(f2)}`, { pr });
  const base2 = await git(["rev-parse", "--verify", "--quiet", `origin/${integration}^{commit}`]);
  if (base2.code !== 0)
    return stop("recheck", "COULD NOT ASK", `origin/${integration} vanished`, { pr });
  if (base2.stdout.trim() !== baseSha)
    return stop(
      "recheck",
      "REFUSED",
      `origin/${integration} moved since the run (${baseSha.slice(0, 12)} → ${base2.stdout.trim().slice(0, 12)}) — merge it and re-run land`,
      { pr },
    );
  line(
    "recheck",
    "ok",
    `#${pr} into ${integration}, head = tested SHA; origin/${integration} unmoved`,
  );

  // 11. Merge commit. A partial PR keeps its branch, so its item still reads as claimed.
  const closes = trailers.closes.length > 0;
  const mergeArgs = [
    "pr",
    "merge",
    String(pr),
    "--merge",
    "--match-head-commit",
    headSha,
    ...(closes ? ["--delete-branch"] : []),
  ];
  const merge = await gh(mergeArgs);
  if (merge.code !== 0) {
    // `--delete-branch` also tidies the local branch, which can fail in a
    // worktree after the merge itself succeeded. Ask GitHub what happened.
    const state = await gh(["pr", "view", String(pr), "--json", "state"]);
    let merged = false;
    try {
      merged =
        state.code === 0 && (JSON.parse(state.stdout) as { state?: string }).state === "MERGED";
    } catch {
      merged = false;
    }
    if (!merged) return stop("merge", "FAILED", `gh pr merge: ${why(merge)}`, { pr });
    line("merge", "warn", `#${pr} merged, but gh reported: ${why(merge)}`);
  } else {
    line(
      "merge",
      "ok",
      `#${pr} as a merge commit${closes ? ", branch deleted (Closes:)" : ", branch kept (no Closes:)"}`,
    );
  }

  // 12. The new integration tip gets its own status.
  const f3 = await git(["fetch", "--quiet", "origin"], 300_000);
  const tip = await git(["rev-parse", "--verify", "--quiet", `origin/${integration}^{commit}`]);
  const mergeSha = tip.code === 0 ? tip.stdout.trim() : undefined;
  if (f3.code !== 0 || !mergeSha)
    return stop("dev-status", "COULD NOT ASK", `could not fetch the merge commit: ${why(f3)}`, {
      pr,
      merged: true,
    });
  const post = await deps.runCi({
    sha: `origin/${integration}`,
    allowUnknown: opts.allowUnknown,
    noStatus: false,
  });
  if (post.exit !== 0 || post.status !== "posted")
    return stop(
      "dev-status",
      post.exit === 1 ? "FAILED" : "COULD NOT ASK",
      `ci:local on ${mergeSha.slice(0, 12)}: ${post.verdict ?? "refused"}, status ${post.status} — the merge landed; re-run \`pnpm ci:local --sha origin/${integration}\``,
      { pr, merged: true, mergeSha },
    );
  line(
    "dev-status",
    "ok",
    `${post.context ?? "local-ci"} on ${mergeSha.slice(0, 12)}${post.reused ? " (content reused)" : ""}`,
  );

  log("");
  log(`land: #${pr} merged into ${integration} at ${mergeSha.slice(0, 12)}.`);
  if (trailers.closes.length) log(`  closes: ${trailers.closes.join(", ")}`);
  if (trailers.progress.length) log(`  progress: ${trailers.progress.join(" | ")}`);
  if (override)
    log(
      `  NOTE: merged on an --allow-unknown override; local-ci was not posted on ${headSha.slice(0, 12)}`,
    );
  return { exit: 0, pr, merged: true, mergeSha };
}

async function main(): Promise<void> {
  const opts = parseLandArgs(process.argv.slice(2));
  if ("error" in opts) {
    console.error(opts.error);
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error("land: no sdlc.config.json above this directory");
    process.exit(1);
  }
  const log = (l: string) => console.log(l);
  const outcome = await runLand(opts, {
    exec: realExec,
    root,
    loadConfig: realLoadConfig,
    log,
    runCi: (o) =>
      runCiLocal(
        o,
        realCiDeps(root, (l) => log(`    ${l}`)),
      ),
    tempDir: () => mkdtempSync(join(tmpdir(), "land-")),
  });
  process.exit(outcome.exit);
}

if (isEntry(import.meta.url)) await main();
