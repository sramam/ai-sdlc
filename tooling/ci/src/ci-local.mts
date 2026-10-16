/**
 * `pnpm ci:local [--sha <ref>] [--allow-unknown] [--no-status] [--container]`
 *
 * CI is local (docs/kit/tech-stack.md), so this is the gate /land relies on. It
 * tests a **snapshot of a commit**, never the working tree, so the session that
 * started it can keep editing while it runs in the background
 * (docs/kit/multi-agent.md). It posts a `local-ci` commit status on that SHA.
 *
 *   1. refuse a dirty tree           — what you see would not be what is tested
 *   2. refuse unless origin/<integration> is an ancestor — it never merges
 *   3. take the per-SHA lock (.ci-local/locks/<sha>.lock); a second run on the
 *      same SHA waits for the first, then usually hits the cache
 *   4. snapshot into its own .ci-local/run-<sha>-<random>/ (shared clone), and
 *      read the CI definition from origin/<integration> — never from the commit
 *      under test, so a branch cannot change what its own gate runs
 *   5. cache key = sha256(tree + resolved steps + node + pnpm + platform/arch +
 *      lockfile + this file's source). A hit skips install and every CONTENT
 *      step; HISTORY steps (below) always run, because they read a commit range
 *      the tree id says nothing about
 *   6. otherwise install, and run each configured step in a scrubbed environment
 *   7. pass / fail / could-not-run per step; n/a does not hold the verdict
 *   8. post the status (unless --no-status). `local-ci` = success only for a
 *      real pass; an --allow-unknown override posts `local-ci/allow-unknown`
 *      instead and leaves `local-ci` unset, so a gate requiring `local-ci`
 *      cannot be satisfied by an override
 *
 * Only the run that created a snapshot removes it, and only on a pass.
 *
 * `--container` runs install and every step inside `ci.container.image`
 * (docker or podman): only the snapshot is mounted, no home directory and no
 * env file, and only the scrubbed variables are passed in. The steps are still
 * the branch's code — tests, lint plugins, install scripts — and a container is
 * what keeps that code off this machine's credentials.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { exec as realExec, firstLine, formatDuration, isEntry } from "../../core/src/exec.mts";
import type { Exec, ExecResult } from "../../core/src/exec.mts";
import {
  CONFIG_FILE,
  findRoot,
  loadConfig as realLoadConfig,
  loadConfigAt as realLoadConfigAt,
} from "../../core/src/config.mts";
import { planWritten } from "../../plan/src/plan-lib.mts";
import type { Applies, CiContainer, CiStep, SdlcConfig } from "../../core/src/config.mts";

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
  /** Run install and the steps inside `ci.container.image`. */
  container?: boolean;
}

export interface Toolchain {
  node: string;
  platform: string;
  arch: string;
}

export interface CiDeps {
  exec: Exec;
  root: string;
  /** The working tree's config: the integration branch's name, and the first-commit fallback. */
  loadConfig: (dir: string) => Promise<SdlcConfig>;
  /**
   * The config committed at a ref; null when that commit has none. The CI
   * definition is read from origin/<integration> with this, never from the
   * commit under test.
   */
  loadConfigAt: (dir: string, ref: string) => Promise<SdlcConfig | null>;
  host: string;
  now: () => number;
  log: (line: string) => void;
  /** Where declared step env names are read from. */
  env: NodeJS.ProcessEnv;
  stepTimeoutMs: number;
  installTimeoutMs: number;
  /** Node, platform and arch for the cache key. Default: this process's. */
  toolchain?: Toolchain;
  /** Hash of the runner's own source for the cache key. Default: this file's. */
  selfHash?: string;
  /** How long to wait for another run holding this SHA's lock. Default 45 minutes. */
  lockWaitMs?: number;
  /** Default: a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Default: `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** The pid written into the lock. Default: process.pid. */
  pid?: number;
}

export type StatusOutcome = "posted" | "skipped" | "push-first" | "could-not-ask";

/** The context a real pass is posted under; the only one a gate should require. */
export const STATUS_CONTEXT = "local-ci";
/** The context an --allow-unknown override is posted under, instead of STATUS_CONTEXT. */
export const OVERRIDE_CONTEXT = "local-ci/allow-unknown";

export interface CiOutcome {
  exit: number;
  /** null when refused before anything ran. */
  verdict: Verdict | null;
  refusal?: string;
  sha?: string;
  tree?: string;
  /** The cache key the content checks were (or would be) remembered under. */
  key?: string;
  /** True when the content checks were skipped on a cache hit. */
  reused: boolean;
  steps: StepResult[];
  status: StatusOutcome;
  /** The context the status was posted under, when one was. */
  context?: string;
  snapshot?: string;
}

const USAGE = "usage: pnpm ci:local [--sha <ref>] [--allow-unknown] [--no-status] [--container]";

export function parseArgs(argv: string[]): CiOptions | { error: string } {
  const opts: CiOptions = { allowUnknown: false, noStatus: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--allow-unknown") opts.allowUnknown = true;
    else if (a === "--no-status") opts.noStatus = true;
    else if (a === "--container") opts.container = true;
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

// ─── Container mode ──────────────────────────────────────────────────────────

/** Host paths: meaningless inside the container, and HOME is exactly what it must not see. */
const HOST_ONLY = new Set(["PATH", "HOME", "TMPDIR"]);

/**
 * What the engine's own CLI needs to reach its daemon. It is the client's
 * environment, never the container's: a docker context lives under HOME.
 */
export const ENGINE_CLIENT_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "CONTAINER_HOST",
  "CONTAINERS_CONF",
];

/**
 * `<engine> run --rm [--network <n>] -v <snapshot>:/work -w /work -e NAME… <image> sh -c '<cmd>'`.
 *
 * Only the snapshot is mounted. Variables pass as `-e NAME` with the value in
 * the engine client's environment, so a declared secret never appears on a
 * command line (and so in `ps`). git is told the mounted tree is safe, since
 * the container's user is not the snapshot's owner.
 */
export function containerCommand(
  c: CiContainer,
  snap: string,
  env: NodeJS.ProcessEnv,
  cmd: string,
  host: NodeJS.ProcessEnv,
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const names = Object.keys(env)
    .filter((k) => !HOST_ONLY.has(k) && env[k] !== undefined)
    .sort();
  const args = [
    "run",
    "--rm",
    ...(c.network ? ["--network", c.network] : []),
    "-v",
    `${snap}:/work`,
    "-w",
    "/work",
    ...names.flatMap((k) => ["-e", k]),
    ...[
      "GIT_CONFIG_COUNT=1",
      "GIT_CONFIG_KEY_0=safe.directory",
      "GIT_CONFIG_VALUE_0=/work",
    ].flatMap((kv) => ["-e", kv]),
    c.image,
    "sh",
    "-c",
    cmd,
  ];
  const client: NodeJS.ProcessEnv = {};
  for (const k of ENGINE_CLIENT_ENV) if (host[k] !== undefined) client[k] = host[k];
  for (const k of names) client[k] = env[k];
  return { cmd: c.engine ?? "docker", args, env: client };
}

// ─── Content checks and history checks ───────────────────────────────────────

/**
 * Steps that read a commit **range** rather than a tree. Two commits with the
 * same tree can carry different messages and different ancestry, so a cached
 * pass of the tree says nothing about them: they run on every invocation,
 * including a cache hit: any step carrying `history: true`, plus the names in
 * this list and any step whose command passes `--range`, for a config that
 * predates the field.
 *
 * A history step runs on a cache hit **without** `pnpm install`, so it must
 * need only node and git — which is already true of the guards it exists for.
 */
export const HISTORY_STEPS = ["trailers"];

export function isHistoryStep(step: CiStep): boolean {
  if (step.history === true) return true;
  if (HISTORY_STEPS.includes(step.name)) return true;
  return /(^|\s)--range(\s|=|$)/.test(step.run);
}

export interface CacheKeyParts {
  tree: string;
  steps: CiStep[];
  node: string;
  pnpm: string;
  platform: string;
  arch: string;
  /** sha256 of pnpm-lock.yaml, or "none". */
  lockfile: string;
  /** sha256 of the runner's own source. */
  self: string;
  /** `<engine>:<image>` in container mode; absent on the host. */
  container?: string;
}

/**
 * What a remembered pass is a fact about. The tree alone was not enough: the
 * same tree passes or fails differently under another Node, another pnpm,
 * another CI definition, or a fixed bug in this runner.
 */
export function cacheKey(p: CacheKeyParts): string {
  const canonical = JSON.stringify([
    ["tree", p.tree],
    ["steps", p.steps],
    ["node", p.node],
    ["pnpm", p.pnpm],
    ["platform", p.platform],
    ["arch", p.arch],
    ["lockfile", p.lockfile],
    ["self", p.self],
    // Only when present, so a host run's key is what it always was.
    ...(p.container ? [["container", p.container]] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function sha256File(path: string): string {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "none";
}

/** Write then rename, so a reader never sees half a marker. */
function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

// ─── The per-SHA lock ────────────────────────────────────────────────────────

interface LockBody {
  pid: number;
  host: string;
  startedAt: string;
}

function parseLock(raw: string): LockBody | null {
  try {
    const v = JSON.parse(raw) as Partial<LockBody>;
    return typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0
      ? { pid: v.pid, host: String(v.host ?? "?"), startedAt: String(v.startedAt ?? "?") }
      : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists and belongs to somebody else — alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_POLL_MS = 1000;

/**
 * `wx` creates the file or fails if it exists, so exactly one run holds a SHA.
 * A lock whose pid is not running (a killed run) is taken over, and said. The
 * takeover re-reads the file and unlinks it only if it still holds the stale
 * body, which leaves a window of one read between two takers; the loser then
 * simply waits. `.ci-local/` is per checkout, so the pid is on this host.
 */
async function acquireLock(
  ciDir: string,
  sha: string,
  deps: CiDeps,
): Promise<{ ok: true; release: () => void } | { ok: false; reason: string }> {
  const dir = join(ciDir, "locks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha}.lock`);
  const rel = relative(deps.root, path);
  const me = JSON.stringify({
    pid: deps.pid ?? process.pid,
    host: deps.host,
    startedAt: new Date().toISOString(),
  } satisfies LockBody);
  const isAlive = deps.isAlive ?? pidAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limit = deps.lockWaitMs ?? 45 * 60_000;
  let waited = 0;
  let announced = false;
  let takeovers = 0;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, `${me}\n`);
      } finally {
        closeSync(fd);
      }
      return {
        ok: true,
        release: () => {
          try {
            if (readFileSync(path, "utf8").trim() === me) unlinkSync(path);
          } catch {
            // Already gone: nothing of ours to release.
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST")
        return { ok: false, reason: `could not create ${rel}: ${(e as Error).message}` };
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // released between our open and our read: try again
    }
    const held = parseLock(raw);
    if (!held || !isAlive(held.pid)) {
      if (++takeovers > 3)
        return {
          ok: false,
          reason: `could not take over the stale lock ${rel}; remove it by hand`,
        };
      deps.log(
        `  taking over a stale lock ${rel}: ${held ? `pid ${held.pid} on ${held.host} (started ${held.startedAt}) is not running` : "its contents are unreadable"}`,
      );
      try {
        if (readFileSync(path, "utf8") === raw) unlinkSync(path);
      } catch {
        // Gone already.
      }
      continue;
    }
    if (!announced) {
      deps.log(
        `  waiting: pid ${held.pid} on ${held.host} has been testing ${sha.slice(0, 12)} since ${held.startedAt} (${rel})`,
      );
      announced = true;
    }
    if (waited >= limit) {
      return {
        ok: false,
        reason: `${sha.slice(0, 12)} is still being tested by pid ${held.pid} after waiting ${formatDuration(waited)}. Remove ${rel} only if that process is gone`,
      };
    }
    await sleep(LOCK_POLL_MS);
    waited += LOCK_POLL_MS;
  }
}

// ─── Applies ─────────────────────────────────────────────────────────────────

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
  context: string = STATUS_CONTEXT,
): Promise<{ outcome: StatusOutcome; detail: string }> {
  const r = await deps.exec(
    "gh",
    [
      "api",
      `repos/{owner}/{repo}/statuses/${sha}`,
      "-f",
      `state=${state}`,
      "-f",
      `context=${context}`,
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

// ─── The run ─────────────────────────────────────────────────────────────────

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
  // The working tree's config names the integration branch; the steps
  // themselves are read from that branch, after the snapshot (4).
  let config: SdlcConfig;
  try {
    config = await deps.loadConfig(deps.root);
  } catch (e) {
    return refuse(`${CONFIG_FILE} did not load: ${(e as Error).message}`);
  }
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

  const treeR = await git(deps, ["rev-parse", `${sha}^{tree}`]);
  if (treeR.code !== 0) return refuse(`could not read the tree of ${sha.slice(0, 12)}`, 2);
  const tree = treeR.stdout.trim();

  // 3. One run per SHA at a time; the second waits and then usually hits the cache.
  const ciDir = join(deps.root, ".ci-local");
  const lock = await acquireLock(ciDir, sha, deps);
  if (!lock.ok) return refuse(lock.reason, 2);
  try {
    return await runLocked(opts, deps, { sha, tree, baseSha, integration, ciDir, started });
  } finally {
    lock.release();
  }
}

async function runLocked(
  opts: CiOptions,
  deps: CiDeps,
  run: {
    sha: string;
    tree: string;
    baseSha: string;
    integration: string;
    ciDir: string;
    started: number;
  },
): Promise<CiOutcome> {
  const { log } = deps;
  const { sha, tree, baseSha, integration, ciDir, started } = run;
  log(`ci:local ${sha.slice(0, 12)} (tree ${tree.slice(0, 12)}) on ${deps.host}`);

  // 4. Snapshot. A shared clone, not an archive: history steps need history,
  // and a clone touches neither this working tree nor its index. The directory
  // is unique to this run, so two runs never delete each other's work.
  // node_modules is installed, never symlinked — a symlinked one resolves
  // workspace packages to the main checkout's source.
  const id = randomBytes(4).toString("hex");
  const snap = join(ciDir, `run-${sha}-${id}`);
  const logs = join(ciDir, `logs-${sha}-${id}`);
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
  const done = (extra: { key?: string; reused?: boolean } = {}) =>
    finish(opts, deps, { sha, tree, steps, snap, started, reused: false, ...extra });

  const t0 = deps.now();
  const snapSteps: Array<[string, string[], NodeJS.ProcessEnv?]> = [
    // --shared points the clone's objects at this checkout by host path, which
    // a container cannot see; a local clone hard-links them instead.
    [
      "clone",
      [
        "clone",
        ...(opts.container ? [] : ["--shared"]),
        "--no-checkout",
        "--quiet",
        deps.root,
        snap,
      ],
    ],
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
      return done();
    }
  }
  record({
    name: "snapshot",
    state: "pass",
    detail: relative(deps.root, snap),
    ms: deps.now() - t0,
  });

  // The CI definition comes from the integration branch, never from the commit
  // under test: a branch that could edit its own gate could switch it off.
  const t1 = deps.now();
  let stepConfig: SdlcConfig;
  try {
    const trusted = await deps.loadConfigAt(deps.root, baseSha);
    if (trusted) {
      stepConfig = trusted;
      const changed = await deps.exec("git", ["diff", "--quiet", baseSha, sha, "--", CONFIG_FILE], {
        cwd: deps.root,
        timeoutMs: 60_000,
      });
      if (changed.code === 1)
        log(
          `  warning: this commit changes ${CONFIG_FILE}. The CI definition is read from origin/${integration}, so the change takes effect only after it lands`,
        );
      else if (changed.code !== 0)
        log(
          `  could not ask whether this commit changes ${CONFIG_FILE} (${firstLine(changed.stderr)})`,
        );
    } else {
      stepConfig = await deps.loadConfig(deps.root);
      log(
        `  origin/${integration} has no ${CONFIG_FILE} yet (the first commit?): using the working tree's, which this commit can change`,
      );
    }
  } catch (e) {
    record({
      name: "config",
      state: "fail",
      detail: `${CONFIG_FILE} on origin/${integration} did not load: ${firstLine((e as Error).message, 200)}`,
      ms: deps.now() - t1,
    });
    return done();
  }
  const configured = stepConfig.ci.steps;
  const installEnv = scrubbedEnv(deps.env);

  // Container mode: the engine must be here, and the image declared on the
  // trusted side. Either missing is could-not-run, which holds the verdict.
  const container = opts.container ? stepConfig.ci.container : undefined;
  if (opts.container) {
    if (!container) {
      record({
        name: "container",
        state: "could-not-run",
        detail: `--container needs ci.container.image in ${CONFIG_FILE} on origin/${integration}`,
        ms: 0,
      });
      return done();
    }
    const engine = container.engine ?? "docker";
    const v = await deps.exec(engine, ["--version"], {
      cwd: deps.root,
      env: containerCommand(container, snap, {}, "", deps.env).env,
      timeoutMs: 30_000,
    });
    if (v.code !== 0) {
      record(
        {
          name: "container",
          state: "could-not-run",
          detail: v.notFound
            ? `${engine} is not installed`
            : v.timedOut
              ? `${engine} --version timed out`
              : `${engine} --version exited ${v.code}`,
          ms: 0,
        },
        v.stderr,
      );
      return done();
    }
    record({
      name: "container",
      state: "pass",
      detail: `${engine} · ${container.image}`,
      ms: 0,
    });
  }

  /** Run a shell command in the snapshot: on the host, or in the container. */
  const shell = (cmd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ExecResult> => {
    if (!container) return deps.exec("sh", ["-c", cmd], { cwd: snap, env, timeoutMs });
    const c = containerCommand(container, snap, env, cmd, deps.env);
    return deps.exec(c.cmd, c.args, { cwd: deps.root, env: c.env, timeoutMs });
  };

  // 5. The cache key. pnpm is asked from the snapshot, in the same scrubbed
  // environment install uses, so a pinned packageManager is what is recorded.
  // In a container the image decides pnpm, and the image is in the key.
  const pv = container
    ? null
    : await deps.exec("pnpm", ["--version"], {
        cwd: snap,
        env: installEnv,
        timeoutMs: 30_000,
      });
  const tc = deps.toolchain ?? {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const key = cacheKey({
    tree,
    steps: configured,
    node: container ? "container" : tc.node,
    pnpm: pv === null ? "container" : pv.code === 0 ? pv.stdout.trim() : "unavailable",
    platform: tc.platform,
    arch: tc.arch,
    lockfile: sha256File(join(snap, "pnpm-lock.yaml")),
    self: deps.selfHash ?? sha256File(fileURLToPath(import.meta.url)),
    container: container ? `${container.engine ?? "docker"}:${container.image}` : undefined,
  });
  const passedDir = join(ciDir, "passed");
  const passedFile = join(passedDir, key);
  const ctx = { deps, snap, ready: true, planDir: stepConfig.dirs.plan, record, shell, container };

  if (existsSync(passedFile)) {
    const history = configured.filter(isHistoryStep);
    log(
      `  content checks already passed on this machine (key ${key.slice(0, 12)}) — not re-running; ${history.length ? `history checks still run: ${history.map((s) => s.name).join(", ")}` : "no history checks configured"}`,
    );
    // No install on a hit: history checks need only node and git (HISTORY_STEPS).
    for (const step of history) await runStep(step, ctx);
    return done({ key, reused: true });
  }

  // 6. Install, then every step in configured order.
  let installed = true;
  if (existsSync(join(snap, "package.json"))) {
    const t = deps.now();
    const exec = (args: string[]) =>
      container
        ? shell(`pnpm ${args.join(" ")}`, installEnv, deps.installTimeoutMs)
        : deps.exec("pnpm", args, { cwd: snap, env: installEnv, timeoutMs: deps.installTimeoutMs });
    // A container has no offline store to read, so it installs online at once.
    let r = await exec(
      container ? ["install", "--frozen-lockfile"] : ["install", "--offline", "--frozen-lockfile"],
    );
    let detail = container ? "online, in the container" : "offline";
    if (!container && r.code !== 0 && !r.notFound && !r.timedOut) {
      log(`  offline install failed (${firstLine(r.stderr || r.stdout)}); retrying online`);
      r = await exec(["install", "--frozen-lockfile"]);
      detail = "online — the offline store was missing a package";
    }
    const state: StepState =
      r.code === 0
        ? "pass"
        : r.notFound || r.timedOut || r.code === 127 || (container && r.code === 125)
          ? "could-not-run"
          : "fail";
    if (state !== "pass") {
      installed = false;
      detail = r.notFound
        ? container
          ? `${container.engine ?? "docker"} not found`
          : "pnpm not found"
        : r.timedOut
          ? "timed out"
          : container && r.code === 125
            ? "the container did not start (exit 125)"
            : `exit ${r.code}`;
    }
    record({ name: "install", state, detail, ms: deps.now() - t }, r.stdout + r.stderr);
  }

  for (const step of configured) await runStep(step, { ...ctx, ready: installed });

  // Remember the content checks only — a clean pass of everything but the
  // history steps. An allow-unknown override is a person's decision about one
  // run, not a fact about the tree, so `unknown` is never remembered.
  const historyNames = new Set(configured.filter(isHistoryStep).map((s) => s.name));
  if (verdictOf(steps.filter((s) => !historyNames.has(s.name))) === "pass") {
    mkdirSync(passedDir, { recursive: true });
    writeAtomic(
      passedFile,
      `${JSON.stringify({ sha, tree, host: deps.host, at: new Date().toISOString() })}\n`,
    );
  }
  return done({ key });
}

async function runStep(
  step: CiStep,
  ctx: {
    deps: CiDeps;
    snap: string;
    /** False when install did not pass: the step is could-not-run. */
    ready: boolean;
    planDir: string;
    record: (s: StepResult, output?: string) => void;
    shell: (cmd: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ExecResult>;
    container?: CiContainer;
  },
): Promise<void> {
  const { deps, snap, record } = ctx;
  const ap = appliesTo(step.applies, snap, ctx.planDir);
  if (!ap.ok) return record({ name: step.name, state: "n/a", detail: `n/a (${ap.reason})`, ms: 0 });
  if (!ctx.ready) {
    return record({
      name: step.name,
      state: "could-not-run",
      detail: "install did not pass",
      ms: 0,
    });
  }
  const t = deps.now();
  const r = await ctx.shell(step.run, scrubbedEnv(deps.env, step.env), deps.stepTimeoutMs);
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
  if (ctx.container && r.code === 125) {
    return record(
      {
        name: step.name,
        state: "could-not-run",
        detail: `the container did not start (exit 125: ${firstLine(r.stderr)})`,
        ms,
      },
      output,
    );
  }
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
  run: {
    sha: string;
    tree: string;
    steps: StepResult[];
    snap: string;
    started: number;
    key?: string;
    reused: boolean;
  },
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
    `  verdict: ${verdict}${verdict === "unknown" ? ` (could not run: ${unknown.join(", ")})` : ""}${run.reused ? " (content checks reused)" : ""} in ${formatDuration(ms)}`,
  );

  const outcome: CiOutcome = {
    exit: 0,
    verdict,
    sha: run.sha,
    tree: run.tree,
    key: run.key,
    reused: run.reused,
    steps: run.steps,
    status: "skipped",
  };
  const reusedNote = run.reused && run.key ? ` · reused ${run.key.slice(0, 7)}` : "";
  const desc = `${deps.host} · ${formatDuration(ms)}${reusedNote}`;
  let state: "success" | "failure" | "error";
  let description = desc;
  let context = STATUS_CONTEXT;
  const logsDir = run.snap.replace(/run-([^/\\]+)$/, "logs-$1");

  if (verdict === "pass") {
    // This run made the snapshot, so this run removes it. Nobody else may.
    rmSync(run.snap, { recursive: true, force: true });
    state = "success";
  } else {
    log(
      `  snapshot kept for inspection: ${relative(deps.root, run.snap)} (logs: ${relative(deps.root, logsDir)})`,
    );
    outcome.snapshot = run.snap;
    if (verdict === "fail") {
      outcome.exit = 1;
      state = "failure";
      description = `${desc} · failed: ${failed.join(", ")}`;
    } else if (opts.allowUnknown) {
      // An override is not a pass. It is posted under its own context, and
      // `local-ci` is left unset, so a gate requiring `local-ci` refuses it.
      state = "success";
      context = OVERRIDE_CONTEXT;
      description = `${desc} · allow-unknown: ${unknown.join(", ")}`;
      log(
        `  --allow-unknown: posting ${OVERRIDE_CONTEXT} (not ${STATUS_CONTEXT}), naming the override`,
      );
    } else {
      outcome.exit = 2;
      state = "error";
      description = `${desc} · could not run: ${unknown.join(", ")}`;
      log(`  the verdict is held; --allow-unknown overrides it under ${OVERRIDE_CONTEXT}`);
    }
  }
  return finishStatus(opts, deps, outcome, state, description, context);
}

async function finishStatus(
  opts: CiOptions,
  deps: CiDeps,
  outcome: CiOutcome,
  state: "success" | "failure" | "error",
  description: string,
  context: string,
): Promise<CiOutcome> {
  if (opts.noStatus || !outcome.sha) {
    deps.log(`  status: not posted (--no-status)`);
    return outcome;
  }
  const posted = await postStatus(deps, outcome.sha, state, description, context);
  outcome.status = posted.outcome;
  if (posted.outcome === "posted") {
    outcome.context = context;
    deps.log(`  status: ${context} ${posted.detail} — "${description}"`);
  } else if (posted.outcome === "push-first") {
    deps.log(`  status: NOT posted — ${posted.detail}`);
    outcome.exit = Math.max(outcome.exit, 1);
  } else {
    deps.log(`  status: could not ask GitHub — ${posted.detail}`);
    outcome.exit = Math.max(outcome.exit, 2);
  }
  return outcome;
}

/** The real dependencies, shared by `main` and by land.mts. */
export function realCiDeps(root: string, log: (line: string) => void = console.log): CiDeps {
  return {
    exec: realExec,
    root,
    loadConfig: realLoadConfig,
    loadConfigAt: (dir, ref) => realLoadConfigAt(dir, ref),
    host: hostname().split(".")[0] ?? "local",
    now: () => Date.now(),
    log,
    env: process.env,
    stepTimeoutMs: 20 * 60_000,
    installTimeoutMs: 10 * 60_000,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if ("error" in opts) {
    console.error(opts.error);
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error("ci:local: no sdlc.config.json above this directory");
    process.exit(1);
  }
  const outcome = await runCiLocal(
    opts,
    realCiDeps(root, (l) => console.log(l)),
  );
  process.exit(outcome.exit);
}

if (isEntry(import.meta.url)) await main();
