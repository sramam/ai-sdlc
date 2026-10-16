/**
 * `pnpm ci:local [--sha <ref>] [--allow-unknown] [--no-status]`
 *
 * CI is local (docs/kit/tech-stack.md), so this is the gate /land relies on. It
 * tests a **snapshot of a commit**, never the working tree, so the session that
 * started it can keep editing while it runs in the background
 * (docs/kit/multi-agent.md). It posts a `local-ci` commit status on that SHA.
 *
 *   1. refuse a dirty tree           — what you see would not be what is tested
 *   2. refuse unless origin/<integration> is an ancestor — it never merges
 *   3. fingerprint = the commit's tree; a tree that already passed is not re-run
 *      (this is how /land gives a merge commit its status in under a second)
 *   4. snapshot into .ci-local/run-<sha>/ with its own `pnpm install`
 *   5. run each configured step in a scrubbed environment
 *   6. pass / fail / could-not-run per step; n/a does not hold the verdict
 *   7. post the status (unless --no-status)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { exec as realExec, firstLine, formatDuration, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { findRoot, loadConfig as realLoadConfig } from "../../core/src/config.mts";
import { planWritten } from "../../plan/src/plan-lib.mts";
import type { Applies, CiStep, SdlcConfig } from "../../core/src/config.mts";

export type StepState = "pass" | "fail" | "could-not-run" | "n/a";
export type Verdict = "pass" | "fail" | "unknown";

export interface StepResult {
  name: string;
  state: StepState;
  detail: string;
  ms: number;
}

export interface CiOptions {
  sha?: string;
  allowUnknown: boolean;
  noStatus: boolean;
}

export interface CiDeps {
  exec: Exec;
  root: string;
  /** Loaded from the snapshot for the steps, so a commit is tested by its own config. */
  loadConfig: (dir: string) => Promise<SdlcConfig>;
  host: string;
  now: () => number;
  log: (line: string) => void;
  /** Where declared step env names are read from. */
  env: NodeJS.ProcessEnv;
  stepTimeoutMs: number;
  installTimeoutMs: number;
}

export type StatusOutcome = "posted" | "skipped" | "push-first" | "could-not-ask";

export interface CiOutcome {
  exit: number;
  /** null when refused before anything ran. */
  verdict: Verdict | null;
  refusal?: string;
  sha?: string;
  tree?: string;
  reused: boolean;
  steps: StepResult[];
  status: StatusOutcome;
  snapshot?: string;
}

const USAGE = "usage: pnpm ci:local [--sha <ref>] [--allow-unknown] [--no-status]";

export function parseArgs(argv: string[]): CiOptions | { error: string } {
  const opts: CiOptions = { allowUnknown: false, noStatus: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-unknown") opts.allowUnknown = true;
    else if (a === "--no-status") opts.noStatus = true;
    else if (a === "--sha") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `--sha needs a ref\n${USAGE}` };
      opts.sha = v;
    } else if (a?.startsWith("--sha=")) opts.sha = a.slice("--sha=".length);
    else return { error: `unknown argument: ${a}\n${USAGE}` };
  }
  return opts;
}

/**
 * Only what a step needs to find its tools, plus what it declares. A step that
 * passes because a credential happened to be in somebody's shell is not
 * proving what it claims (door_nexa ran a "hermetic" suite against a
 * developer's .env for a year).
 */
export function scrubbedEnv(source: NodeJS.ProcessEnv, declared: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", NODE_ENV: "test" };
  for (const k of ["PATH", "HOME", "TMPDIR"]) if (source[k] !== undefined) env[k] = source[k];
  for (const k of declared) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

function hasPackageDir(dir: string, sub: string): boolean {
  const base = join(dir, sub);
  if (!existsSync(base)) return false;
  return readdirSync(base, { withFileTypes: true }).some(
    (d) => d.isDirectory() && existsSync(join(base, d.name, "package.json")),
  );
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".ci-local", ".claude", "dist", "coverage"]);
// The starter's own tooling is not the project's source; neither is config.
const NOT_SOURCE = ["tooling/", "scripts/one-of/"];

export function hasSource(dir: string): boolean {
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        const rel = `${relative(dir, join(d, e.name))}/`;
        if (NOT_SOURCE.some((p) => rel.startsWith(p))) continue;
        if (walk(join(d, e.name))) return true;
      } else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.config\.(ts|mts)$/.test(e.name)) {
        return true;
      }
    }
    return false;
  };
  return walk(dir);
}

/**
 * Has `/plan` run? The starter ships a placeholder `docs/plan/README.md`, so
 * existence is not the signal. Asked of plan-lib so ci:local and plan:check
 * cannot disagree about which stage the repository is in.
 */
export function hasPlan(dir: string, planDir = "docs/plan"): boolean {
  const readme = join(dir, planDir, "README.md");
  return existsSync(readme) && planWritten(readFileSync(readme, "utf8"));
}

export function appliesTo(
  kind: Applies,
  dir: string,
  planDir?: string,
): { ok: true } | { ok: false; reason: string } {
  switch (kind) {
    case "always":
      return { ok: true };
    case "has-apps":
      return hasPackageDir(dir, "apps")
        ? { ok: true }
        : { ok: false, reason: "no app under apps/" };
    case "has-packages":
      return hasPackageDir(dir, "packages")
        ? { ok: true }
        : { ok: false, reason: "no package under packages/" };
    case "has-source":
      return hasSource(dir) ? { ok: true } : { ok: false, reason: "no source files yet" };
    case "has-plan":
      return hasPlan(dir, planDir)
        ? { ok: true }
        : { ok: false, reason: "no plan yet (/plan has not run)" };
  }
}

export function verdictOf(steps: StepResult[]): Verdict {
  if (steps.some((s) => s.state === "fail")) return "fail";
  if (steps.some((s) => s.state === "could-not-run")) return "unknown";
  return "pass";
}

function tail(text: string, lines = 30): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

async function git(deps: CiDeps, args: string[], cwd = deps.root) {
  return deps.exec("git", args, { cwd, timeoutMs: 60_000 });
}

/**
 * The status, read by /land and the promote scripts. GitHub caps a
 * description at 140 characters.
 */
export async function postStatus(
  deps: Pick<CiDeps, "exec" | "root">,
  sha: string,
  state: "success" | "failure" | "error",
  description: string,
): Promise<{ outcome: StatusOutcome; detail: string }> {
  const r = await deps.exec(
    "gh",
    [
      "api",
      `repos/{owner}/{repo}/statuses/${sha}`,
      "-f",
      `state=${state}`,
      "-f",
      "context=local-ci",
      "-f",
      `description=${description.slice(0, 140)}`,
    ],
    { cwd: deps.root, timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
  );
  if (r.notFound) return { outcome: "could-not-ask", detail: "gh is not installed" };
  if (r.timedOut) return { outcome: "could-not-ask", detail: "gh timed out" };
  if (r.code === 0) return { outcome: "posted", detail: `${state} on ${sha.slice(0, 12)}` };
  const said = `${r.stderr}\n${r.stdout}`;
  if (/HTTP 422|No commit found/i.test(said)) {
    return {
      outcome: "push-first",
      detail: `${sha.slice(0, 12)} is not on GitHub — push first, then re-run`,
    };
  }
  return { outcome: "could-not-ask", detail: firstLine(said) || `gh exited ${r.code}` };
}

export async function runCiLocal(opts: CiOptions, deps: CiDeps): Promise<CiOutcome> {
  const { log } = deps;
  const started = deps.now();
  const refuse = (refusal: string, exit = 1): CiOutcome => {
    log(`ci:local refused: ${refusal}`);
    return { exit, verdict: null, refusal, reused: false, steps: [], status: "skipped" };
  };

  // 1. Dirty tree. `git status --porcelain` already leaves out ignored files.
  const status = await git(deps, ["status", "--porcelain"]);
  if (status.code !== 0)
    return refuse(`could not ask git for the tree's state (${firstLine(status.stderr)})`, 2);
  if (status.stdout.trim()) {
    const lines = status.stdout.trimEnd().split("\n");
    return refuse(
      `the tree is dirty — commit or remove these first, since ci:local tests a commit:\n  ${lines.slice(0, 10).join("\n  ")}${lines.length > 10 ? `\n  … and ${lines.length - 10} more` : ""}`,
    );
  }

  // 2. Resolve, and require the integration branch underneath it.
  const config = await deps.loadConfig(deps.root);
  const integration = config.branches.integration;
  const ref = opts.sha ?? "HEAD";
  const resolved = await git(deps, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (resolved.code !== 0 || !resolved.stdout.trim()) {
    return refuse(
      ref === "HEAD"
        ? "HEAD has no commit yet — nothing to test"
        : `cannot resolve ${ref} to a commit`,
    );
  }
  const sha = resolved.stdout.trim();
  const base = await git(deps, [
    "rev-parse",
    "--verify",
    "--quiet",
    `origin/${integration}^{commit}`,
  ]);
  if (base.code !== 0 || !base.stdout.trim()) {
    return refuse(
      `origin/${integration} not found — run \`git fetch\`, or \`pnpm sdlc:init\` on a new repository`,
    );
  }
  const baseSha = base.stdout.trim();
  const anc = await git(deps, ["merge-base", "--is-ancestor", baseSha, sha]);
  if (anc.code === 1) {
    return refuse(
      `${sha.slice(0, 12)} does not contain origin/${integration} — \`git merge origin/${integration}\` first (ci:local never merges)`,
    );
  }
  if (anc.code !== 0)
    return refuse(
      `could not ask whether origin/${integration} is an ancestor (${firstLine(anc.stderr)})`,
      2,
    );

  // 3. Fingerprint. The tree is a content hash of every committed file, so
  // a merge commit whose tree already passed needs no second run.
  const treeR = await git(deps, ["rev-parse", `${sha}^{tree}`]);
  if (treeR.code !== 0) return refuse(`could not read the tree of ${sha.slice(0, 12)}`, 2);
  const tree = treeR.stdout.trim();
  const ciDir = join(deps.root, ".ci-local");
  const passedFile = join(ciDir, "passed", tree);
  log(`ci:local ${sha.slice(0, 12)} (tree ${tree.slice(0, 12)}) on ${deps.host}`);

  if (existsSync(passedFile)) {
    log(`  tree ${tree.slice(0, 12)} already passed on this machine — not re-running`);
    const outcome: CiOutcome = {
      exit: 0,
      verdict: "pass",
      sha,
      tree,
      reused: true,
      steps: [],
      status: "skipped",
    };
    return finishStatus(
      opts,
      deps,
      outcome,
      "success",
      `${deps.host} · ${formatDuration(deps.now() - started)} · reused ${tree.slice(0, 7)}`,
    );
  }

  // 4. Snapshot. A shared clone, not an archive: steps such as `trailers
  // --range` need history, and a clone touches neither this working tree nor
  // its index. node_modules is installed, never symlinked — a symlinked one
  // resolves workspace packages to the main checkout's source.
  const snap = join(ciDir, `run-${sha}`);
  const logs = join(ciDir, `logs-${sha}`);
  rmSync(snap, { recursive: true, force: true });
  rmSync(logs, { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  const steps: StepResult[] = [];
  const record = (s: StepResult, output = "") => {
    steps.push(s);
    const label =
      s.state === "pass"
        ? "pass"
        : s.state === "fail"
          ? "FAIL"
          : s.state === "n/a"
            ? "n/a "
            : "COULD NOT RUN";
    log(
      `  ${label.padEnd(13)} ${s.name.padEnd(16)} ${s.state === "n/a" ? "" : formatDuration(s.ms).padEnd(7)} ${s.detail}`.trimEnd(),
    );
    if (output) writeFileSync(join(logs, `${s.name.replace(/[^\w.-]/g, "_")}.log`), output);
    if (s.state === "fail" || s.state === "could-not-run") {
      if (output.trim()) log(tail(output).replace(/^/gm, "      | "));
    }
  };

  const t0 = deps.now();
  const snapSteps: Array<[string, string[], NodeJS.ProcessEnv?]> = [
    ["clone", ["clone", "--shared", "--no-checkout", "--quiet", deps.root, snap]],
    ["ref", ["-C", snap, "update-ref", `refs/remotes/origin/${integration}`, baseSha]],
    // LFS objects are not fetched into a snapshot; pointers are what is tested.
    [
      "checkout",
      ["-C", snap, "checkout", "--quiet", "--detach", sha],
      { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
    ],
  ];
  for (const [what, args, env] of snapSteps) {
    const r = await deps.exec("git", args, { cwd: deps.root, timeoutMs: 300_000, env });
    if (r.code !== 0) {
      record(
        {
          name: "snapshot",
          state: "could-not-run",
          detail: `git ${what} failed: ${firstLine(r.stderr)}`,
          ms: deps.now() - t0,
        },
        r.stderr,
      );
      return finish(opts, deps, { sha, tree, steps, snap, started });
    }
  }
  record({
    name: "snapshot",
    state: "pass",
    detail: relative(deps.root, snap),
    ms: deps.now() - t0,
  });

  let stepConfig: SdlcConfig;
  try {
    stepConfig = await deps.loadConfig(snap);
  } catch (e) {
    record({
      name: "config",
      state: "fail",
      detail: `sdlc.config.ts in the commit did not load: ${(e as Error).message}`,
      ms: 0,
    });
    return finish(opts, deps, { sha, tree, steps, snap, started });
  }

  const installEnv = scrubbedEnv(deps.env);
  let installed = true;
  if (existsSync(join(snap, "package.json"))) {
    const t = deps.now();
    const run = (args: string[]) =>
      deps.exec("pnpm", args, { cwd: snap, env: installEnv, timeoutMs: deps.installTimeoutMs });
    let r = await run(["install", "--offline", "--frozen-lockfile"]);
    let detail = "offline";
    if (r.code !== 0 && !r.notFound && !r.timedOut) {
      log(`  offline install failed (${firstLine(r.stderr || r.stdout)}); retrying online`);
      r = await run(["install", "--frozen-lockfile"]);
      detail = "online — the offline store was missing a package";
    }
    const state: StepState =
      r.code === 0 ? "pass" : r.notFound || r.timedOut || r.code === 127 ? "could-not-run" : "fail";
    if (state !== "pass") {
      installed = false;
      detail = r.notFound ? "pnpm not found" : r.timedOut ? "timed out" : `exit ${r.code}`;
    }
    record({ name: "install", state, detail, ms: deps.now() - t }, r.stdout + r.stderr);
  }

  // 5–6. The steps, in order.
  for (const step of stepConfig.ci.steps) {
    await runStep(step, { deps, snap, installed, planDir: stepConfig.dirs.plan, record });
  }
  return finish(opts, deps, { sha, tree, steps, snap, started });
}

async function runStep(
  step: CiStep,
  ctx: {
    deps: CiDeps;
    snap: string;
    installed: boolean;
    planDir: string;
    record: (s: StepResult, output?: string) => void;
  },
): Promise<void> {
  const { deps, snap, record } = ctx;
  const ap = appliesTo(step.applies, snap, ctx.planDir);
  if (!ap.ok) return record({ name: step.name, state: "n/a", detail: `n/a (${ap.reason})`, ms: 0 });
  if (!ctx.installed) {
    return record({
      name: step.name,
      state: "could-not-run",
      detail: "install did not pass",
      ms: 0,
    });
  }
  const t = deps.now();
  const r = await deps.exec("sh", ["-c", step.run], {
    cwd: snap,
    env: scrubbedEnv(deps.env, step.env),
    timeoutMs: deps.stepTimeoutMs,
  });
  const ms = deps.now() - t;
  const output = r.stdout + r.stderr;
  if (r.timedOut)
    return record(
      {
        name: step.name,
        state: "could-not-run",
        detail: `timed out after ${formatDuration(deps.stepTimeoutMs)}`,
        ms,
      },
      output,
    );
  if (r.notFound || r.code === 127) {
    return record(
      {
        name: step.name,
        state: "could-not-run",
        detail: `command not found (${firstLine(r.stderr)})`,
        ms,
      },
      output,
    );
  }
  if (r.code === 0) return record({ name: step.name, state: "pass", detail: "", ms }, output);
  return record(
    { name: step.name, state: "fail", detail: `exit ${r.code ?? "signal"}`, ms },
    output,
  );
}

async function finish(
  opts: CiOptions,
  deps: CiDeps,
  run: { sha: string; tree: string; steps: StepResult[]; snap: string; started: number },
): Promise<CiOutcome> {
  const { log } = deps;
  const verdict = verdictOf(run.steps);
  const ms = deps.now() - run.started;

  log("");
  log("  step              result          time");
  for (const s of run.steps) {
    const res = s.state === "n/a" ? s.detail : s.state;
    log(
      `  ${s.name.padEnd(17)} ${res.padEnd(15)} ${s.state === "n/a" ? "" : formatDuration(s.ms)}`.trimEnd(),
    );
  }
  const unknown = run.steps.filter((s) => s.state === "could-not-run").map((s) => s.name);
  const failed = run.steps.filter((s) => s.state === "fail").map((s) => s.name);
  log(
    `  verdict: ${verdict}${verdict === "unknown" ? ` (could not run: ${unknown.join(", ")})` : ""} in ${formatDuration(ms)}`,
  );

  const outcome: CiOutcome = {
    exit: 0,
    verdict,
    sha: run.sha,
    tree: run.tree,
    reused: false,
    steps: run.steps,
    status: "skipped",
  };
  const desc = `${deps.host} · ${formatDuration(ms)}`;
  let state: "success" | "failure" | "error";
  let description = desc;

  if (verdict === "pass") {
    // Only a clean pass is remembered. An allow-unknown override is a person's
    // decision about one run, not a fact about the tree.
    mkdirSync(join(deps.root, ".ci-local", "passed"), { recursive: true });
    writeFileSync(
      join(deps.root, ".ci-local", "passed", run.tree),
      `${JSON.stringify({ sha: run.sha, host: deps.host, ms, at: new Date().toISOString() })}\n`,
    );
    rmSync(run.snap, { recursive: true, force: true });
    state = "success";
  } else {
    log(
      `  snapshot kept for inspection: ${relative(deps.root, run.snap)} (logs: ${relative(deps.root, run.snap).replace("run-", "logs-")})`,
    );
    outcome.snapshot = run.snap;
    if (verdict === "fail") {
      outcome.exit = 1;
      state = "failure";
      description = `${desc} · failed: ${failed.join(", ")}`;
    } else if (opts.allowUnknown) {
      state = "success";
      description = `${desc} · allow-unknown: ${unknown.join(", ")}`;
      log(`  --allow-unknown: posting success, with the override in the status description`);
    } else {
      outcome.exit = 2;
      state = "error";
      description = `${desc} · could not run: ${unknown.join(", ")}`;
      log(`  the verdict is held; --allow-unknown overrides it and says so in the status`);
    }
  }
  return finishStatus(opts, deps, outcome, state, description);
}

async function finishStatus(
  opts: CiOptions,
  deps: CiDeps,
  outcome: CiOutcome,
  state: "success" | "failure" | "error",
  description: string,
): Promise<CiOutcome> {
  if (opts.noStatus || !outcome.sha) {
    deps.log(`  status: not posted (--no-status)`);
    return outcome;
  }
  const posted = await postStatus(deps, outcome.sha, state, description);
  outcome.status = posted.outcome;
  if (posted.outcome === "posted")
    deps.log(`  status: local-ci ${posted.detail} — "${description}"`);
  else if (posted.outcome === "push-first") {
    deps.log(`  status: NOT posted — ${posted.detail}`);
    outcome.exit = Math.max(outcome.exit, 1);
  } else {
    deps.log(`  status: could not ask GitHub — ${posted.detail}`);
    outcome.exit = Math.max(outcome.exit, 2);
  }
  return outcome;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if ("error" in opts) {
    console.error(opts.error);
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error("ci:local: no sdlc.config.ts above this directory");
    process.exit(1);
  }
  const outcome = await runCiLocal(opts, {
    exec: realExec,
    root,
    loadConfig: realLoadConfig,
    host: hostname().split(".")[0] ?? "local",
    now: () => Date.now(),
    log: (l) => console.log(l),
    env: process.env,
    stepTimeoutMs: 20 * 60_000,
    installTimeoutMs: 10 * 60_000,
  });
  process.exit(outcome.exit);
}

if (isEntry(import.meta.url)) await main();
