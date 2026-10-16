import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadConfigAt } from "../../core/src/config.mts";
import type { SdlcConfig } from "../../core/src/config.mts";
import {
  appliesTo,
  cacheKey,
  containerCommand,
  hasPlan,
  isHistoryStep,
  hasSource,
  parseArgs,
  runCiLocal,
  scrubbedEnv,
  verdictOf,
} from "./ci-local.mts";
import type { CiDeps, CiOptions } from "./ci-local.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult, ScriptedCall } from "../../core/src/exec.mts";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ci-local-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function config(steps: SdlcConfig["ci"]["steps"]): SdlcConfig {
  return {
    branches: { integration: "dev", staging: "staging", production: "main" },
    dirs: {
      requirements: "docs/requirements",
      plan: "docs/plan",
      progress: "docs/progress",
      adr: "docs/adr",
      handoffs: "docs/handoffs",
    },
    claimStaleDays: 7,
    cadence: { progressReportWeekdays: [1, 4], planSyncDays: 7 },
    accounts: [],
    ci: { steps },
    coverage: { floors: {} },
  };
}

type Rule = [RegExp | string, ExecResult | ((c: ScriptedCall) => ExecResult)];

/** A repository that is clean, current with origin/dev, and checks out to `files`. */
function gitRules(
  files: Record<string, string> = { "package.json": "{}" },
  over: Rule[] = [],
): Rule[] {
  return [
    ...over,
    ["git status --porcelain", result(0, "")],
    [/^git rev-parse --verify --quiet HEAD\^\{commit\}$/, result(0, `${SHA}\n`)],
    [/^git rev-parse --verify --quiet origin\/dev\^\{commit\}$/, result(0, `${BASE}\n`)],
    [/^git merge-base --is-ancestor/, result(0)],
    [/^git rev-parse \w+\^\{tree\}$/, result(0, `${TREE}\n`)],
    [/^git clone /, (c) => (mkdirSync(c.args.at(-1) as string, { recursive: true }), result(0))],
    [/^git -C \S+ update-ref/, result(0)],
    [/^git diff --quiet /, result(0)],
    [
      /^git -C \S+ checkout/,
      (c) => {
        const dir = c.args[1] as string;
        for (const [f, body] of Object.entries(files)) {
          mkdirSync(join(dir, f, ".."), { recursive: true });
          writeFileSync(join(dir, f), body);
        }
        return result(0);
      },
    ],
    [/^pnpm --version$/, result(0, "10.0.0\n")],
    [/^pnpm install --offline/, result(0)],
    [/^gh api repos\/\{owner\}\/\{repo\}\/statuses/, result(0, "{}")],
  ];
}

const TOOLCHAIN = { node: "v24.0.0", platform: "linux", arch: "x64" };

function deps(
  rules: Rule[],
  cfg: SdlcConfig,
  env: NodeJS.ProcessEnv = {},
  over: Partial<CiDeps> = {},
) {
  const fake = scriptedExec(rules);
  const lines: string[] = [];
  let t = 0;
  const d: CiDeps = {
    exec: fake,
    root,
    loadConfig: async () => cfg,
    loadConfigAt: async () => cfg,
    host: "laptop",
    now: () => (t += 100),
    log: (l) => lines.push(l),
    env: {
      PATH: "/bin",
      HOME: "/home/x",
      TMPDIR: "/tmp",
      SECRET: "s3cret",
      DECLARED: "yes",
      ...env,
    },
    stepTimeoutMs: 1000,
    installTimeoutMs: 1000,
    toolchain: TOOLCHAIN,
    selfHash: "self",
    sleep: async () => {},
    ...over,
  };
  return { d, fake, lines, out: () => lines.join("\n") };
}

const opts = (o: Partial<CiOptions> = {}): CiOptions => ({
  allowUnknown: false,
  noStatus: false,
  ...o,
});
const ciDir = () => join(root, ".ci-local");
const runDirs = () =>
  existsSync(ciDir()) ? readdirSync(ciDir()).filter((n) => n.startsWith("run-")) : [];
const passed = () =>
  existsSync(join(ciDir(), "passed")) ? readdirSync(join(ciDir(), "passed")) : [];
const statusCall = (fake: { calls: ScriptedCall[] }) => fake.calls.find((c) => c.cmd === "gh");
const field = (c: ScriptedCall | undefined, k: string) =>
  c?.args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);

describe("refusals", () => {
  it("refuses a dirty tree and names what is dirty", async () => {
    const { d, out } = deps(
      [["git status --porcelain", result(0, " M src/a.ts\n?? new.ts\n")]],
      config([]),
    );
    const o = await runCiLocal(opts(), d);
    expect(o.exit).toBe(1);
    expect(o.verdict).toBeNull();
    expect(out()).toMatch(/dirty[\s\S]*src\/a\.ts/);
  });

  it("refuses a commit that does not contain origin/dev, and never merges", async () => {
    const { d, fake, out } = deps(
      gitRules({}, [[/^git merge-base --is-ancestor/, result(1)]]),
      config([]),
    );
    const o = await runCiLocal(opts(), d);
    expect(o.exit).toBe(1);
    expect(out()).toMatch(/git merge origin\/dev.*never merges/);
    expect(fake.calls.some((c) => c.args.includes("merge") && !c.args.includes("merge-base"))).toBe(
      false,
    );
  });

  it("refuses when origin/dev does not exist yet", async () => {
    const { d, out } = deps(gitRules({}, [[/origin\/dev\^\{commit\}/, result(1)]]), config([]));
    expect((await runCiLocal(opts(), d)).exit).toBe(1);
    expect(out()).toMatch(/origin\/dev not found/);
  });

  it("refuses an empty repository with no commit to test", async () => {
    const { d, out } = deps(gitRules({}, [[/HEAD\^\{commit\}/, result(128)]]), config([]));
    expect((await runCiLocal(opts(), d)).exit).toBe(1);
    expect(out()).toMatch(/no commit yet/);
  });

  it("tests the ref named by --sha", async () => {
    const { d, fake } = deps(
      gitRules({}, [[/origin\/dev~0\^\{commit\}/, result(0, `${SHA}\n`)]]),
      config([]),
    );
    await runCiLocal(opts({ sha: "origin/dev~0", noStatus: true }), d);
    expect(fake.calls.some((c) => c.args.includes("origin/dev~0^{commit}"))).toBe(true);
  });
});

describe("a full run", () => {
  const steps = [
    { name: "lint", run: "pnpm run lint", applies: "always" as const, env: ["DECLARED"] },
    { name: "build", run: "pnpm run build", applies: "has-apps" as const },
  ];

  it("passes, scrubs the environment, skips n/a, remembers the tree and posts success", async () => {
    const { d, fake, out } = deps(
      [[/^sh -c pnpm run lint/, result(0, "ok")], ...gitRules()],
      config(steps),
    );
    const o = await runCiLocal(opts(), d);
    expect(o).toMatchObject({ exit: 0, verdict: "pass", reused: false, status: "posted" });
    expect(o.steps.map((s) => [s.name, s.state])).toEqual([
      ["snapshot", "pass"],
      ["install", "pass"],
      ["lint", "pass"],
      ["build", "n/a"],
    ]);
    expect(out()).toMatch(/n\/a \(no app under apps\/\)/);

    const lint = fake.calls.find((c) => c.cmd === "sh");
    expect(lint?.opts.env).toEqual({
      CI: "1",
      NODE_ENV: "test",
      PATH: "/bin",
      HOME: "/home/x",
      TMPDIR: "/tmp",
      DECLARED: "yes",
    });
    expect(lint?.opts.cwd).toMatch(new RegExp(`/\\.ci-local/run-${SHA}-[0-9a-f]{8}$`));

    expect(passed()).toHaveLength(1);
    expect(runDirs()).toEqual([]);
    expect(existsSync(join(ciDir(), "locks", `${SHA}.lock`))).toBe(false);
    const gh = statusCall(fake);
    expect(gh?.args[1]).toBe(`repos/{owner}/{repo}/statuses/${SHA}`);
    expect(field(gh, "state")).toBe("success");
    expect(field(gh, "context")).toBe("local-ci");
    expect(field(gh, "description")).toMatch(/^laptop · /);
  });

  it("points the snapshot's origin/dev at the real one, so range steps see history", async () => {
    const { d, fake } = deps(gitRules(), config([]));
    await runCiLocal(opts({ noStatus: true }), d);
    const ref = fake.calls.find((c) => c.args.includes("update-ref"));
    expect(ref?.args.slice(-2)).toEqual(["refs/remotes/origin/dev", BASE]);
  });

  it("skips content checks for a key that already passed — the post-merge fingerprint", async () => {
    const lintOk: Rule = [/^sh -c pnpm run lint/, result(0)];
    await runCiLocal(opts(), deps([lintOk, ...gitRules()], config(steps)).d);
    expect(passed()).toHaveLength(1);

    const { d, fake } = deps([lintOk, ...gitRules()], config(steps));
    const o = await runCiLocal(opts({ sha: "HEAD" }), d);
    expect(o).toMatchObject({ exit: 0, verdict: "pass", reused: true, status: "posted" });
    expect(o.key).toBe(passed()[0]);
    expect(fake.calls.some((c) => c.cmd === "sh" || c.args[0] === "install")).toBe(false);
    expect(field(statusCall(fake), "description")).toMatch(
      new RegExp(`reused ${o.key?.slice(0, 7)}`),
    );
    expect(runDirs()).toEqual([]);
  });

  it("fails, keeps the snapshot, posts failure and prints the step's output", async () => {
    const { d, fake, out } = deps(
      [[/^sh -c pnpm run lint/, result(1, "", "src/x.ts: 3 problems")], ...gitRules()],
      config(steps),
    );
    const o = await runCiLocal(opts(), d);
    expect(o).toMatchObject({ exit: 1, verdict: "fail" });
    expect(runDirs()).toHaveLength(1);
    expect(o.snapshot).toMatch(new RegExp(`run-${SHA}-[0-9a-f]{8}$`));
    expect(passed()).toEqual([]);
    expect(out()).toMatch(/3 problems/);
    expect(out()).toMatch(/snapshot kept for inspection/);
    expect(field(statusCall(fake), "state")).toBe("failure");
    expect(field(statusCall(fake), "description")).toMatch(/failed: lint/);
  });

  it("holds an unknown verdict when a command is not found", async () => {
    const { d, fake } = deps(
      [[/^sh -c pnpm run lint/, result(127, "", "sh: pnpm: not found")], ...gitRules()],
      config(steps),
    );
    const o = await runCiLocal(opts(), d);
    expect(o).toMatchObject({ exit: 2, verdict: "unknown" });
    expect(field(statusCall(fake), "state")).toBe("error");
  });

  it("treats a timeout as could-not-run", async () => {
    const timedOut: ExecResult = {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      notFound: false,
    };
    const { d } = deps([[/^sh -c pnpm run lint/, timedOut], ...gitRules()], config(steps));
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(o.steps.find((s) => s.name === "lint")?.state).toBe("could-not-run");
  });

  it("--allow-unknown posts local-ci/allow-unknown, never local-ci, and remembers nothing", async () => {
    const { d, fake } = deps([[/^sh -c pnpm run lint/, result(127)], ...gitRules()], config(steps));
    const o = await runCiLocal(opts({ allowUnknown: true }), d);
    expect(o).toMatchObject({ exit: 0, verdict: "unknown", context: "local-ci/allow-unknown" });
    const gh = fake.calls.filter((c) => c.cmd === "gh");
    expect(gh).toHaveLength(1);
    expect(field(gh[0], "context")).toBe("local-ci/allow-unknown");
    expect(field(gh[0], "state")).toBe("success");
    expect(field(gh[0], "description")).toMatch(/allow-unknown: lint/);
    expect(passed()).toEqual([]);
  });

  it("a real pass posts under local-ci", async () => {
    const { d, fake } = deps([[/^sh -c pnpm run lint/, result(0)], ...gitRules()], config(steps));
    const o = await runCiLocal(opts(), d);
    expect(o.context).toBe("local-ci");
    expect(field(statusCall(fake), "context")).toBe("local-ci");
  });

  it("falls back to an online install, and says so", async () => {
    const { d, out } = deps(
      [
        [/^pnpm install --offline/, result(1, "", "ERR_PNPM_NO_OFFLINE_TARBALL")],
        [/^pnpm install --frozen/, result(0)],
        ...gitRules(),
      ],
      config([]),
    );
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(o.verdict).toBe("pass");
    expect(out()).toMatch(/offline install failed.*retrying online/);
  });

  it("does not run steps when install failed", async () => {
    const { d, fake } = deps(
      [[/^pnpm install/, result(1, "", "lockfile out of date")], ...gitRules()],
      config(steps),
    );
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(o.verdict).toBe("fail");
    expect(fake.calls.some((c) => c.cmd === "sh")).toBe(false);
    expect(o.steps.find((s) => s.name === "lint")?.state).toBe("could-not-run");
  });
});

describe("the cache", () => {
  const steps = [
    { name: "lint", run: "pnpm run lint", applies: "always" as const },
    {
      name: "trailers",
      run: "node tooling/guards/src/trailers.mts --range",
      applies: "always" as const,
    },
  ];
  const ok: Rule[] = [
    [/^sh -c pnpm run lint/, result(0)],
    [/^sh -c node tooling\/guards/, result(0)],
  ];

  it("classifies history checks by name, by --range, and by an optional history flag", () => {
    const s = (name: string, run: string, extra = {}) => ({
      name,
      run,
      applies: "always" as const,
      ...extra,
    });
    expect(isHistoryStep(s("trailers", "anything"))).toBe(true);
    expect(isHistoryStep(s("commits", "node x.mts --range origin/dev"))).toBe(true);
    expect(isHistoryStep(s("commits", "node x.mts --range=origin/dev"))).toBe(true);
    expect(isHistoryStep(s("custom", "node y.mts", { history: true }))).toBe(true);
    expect(isHistoryStep(s("custom", "node y.mts", { history: "yes" }))).toBe(false);
    expect(isHistoryStep(s("lint", "pnpm run lint --rangefinder"))).toBe(false);
  });

  it("the key changes with every part of the toolchain and definition", () => {
    const base = {
      tree: TREE,
      steps,
      node: "v24.0.0",
      pnpm: "10.0.0",
      platform: "linux",
      arch: "x64",
      lockfile: "l",
      self: "s",
    };
    const k = cacheKey(base);
    expect(cacheKey({ ...base })).toBe(k);
    for (const change of [
      { tree: "d".repeat(40) },
      { steps: [steps[0]!] },
      { node: "v24.1.0" },
      { pnpm: "10.0.1" },
      { platform: "darwin" },
      { arch: "arm64" },
      { lockfile: "l2" },
      { self: "s2" },
    ])
      expect(cacheKey({ ...base, ...change }), JSON.stringify(change)).not.toBe(k);
  });

  it("a different pnpm or node is a miss, not a reused pass", async () => {
    await runCiLocal(opts({ noStatus: true }), deps([...ok, ...gitRules()], config(steps)).d);
    expect(passed()).toHaveLength(1);

    const pnpm11: Rule = [/^pnpm --version$/, result(0, "11.0.0\n")];
    const a = deps([pnpm11, ...ok, ...gitRules()], config(steps));
    const o1 = await runCiLocal(opts({ noStatus: true }), a.d);
    expect(o1.reused).toBe(false);
    expect(a.fake.calls.some((c) => c.args.join(" ") === "-c pnpm run lint")).toBe(true);

    const b = deps(
      [...ok, ...gitRules()],
      config(steps),
      {},
      {
        toolchain: { ...TOOLCHAIN, node: "v25.0.0" },
      },
    );
    expect((await runCiLocal(opts({ noStatus: true }), b.d)).reused).toBe(false);
    expect(passed()).toHaveLength(3);
  });

  it("a changed lockfile in the commit is a miss", async () => {
    const lock = (body: string) => gitRules({ "package.json": "{}", "pnpm-lock.yaml": body });
    await runCiLocal(opts({ noStatus: true }), deps([...ok, ...lock("v1")], config(steps)).d);
    const o = await runCiLocal(
      opts({ noStatus: true }),
      deps([...ok, ...lock("v2")], config(steps)).d,
    );
    expect(o.reused).toBe(false);
  });

  it("still runs history checks on a cache hit, and fails on them", async () => {
    await runCiLocal(opts(), deps([...ok, ...gitRules()], config(steps)).d);

    const { d, fake, out } = deps(
      [
        [/^sh -c pnpm run lint/, result(0)],
        [/^sh -c node tooling\/guards/, result(1, "none of 2 commit(s) carries a Progress:")],
        ...gitRules(),
      ],
      config(steps),
    );
    const o = await runCiLocal(opts(), d);
    expect(o).toMatchObject({ reused: true, verdict: "fail", exit: 1 });
    expect(o.steps.map((s) => [s.name, s.state])).toEqual([
      ["snapshot", "pass"],
      ["trailers", "fail"],
    ]);
    // The content step and the install did not run again; the history step did.
    const ran = fake.calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(ran.some((l) => l.includes("pnpm run lint"))).toBe(false);
    expect(ran.some((l) => l.startsWith("pnpm install"))).toBe(false);
    expect(ran.some((l) => l.includes("trailers.mts --range"))).toBe(true);
    expect(out()).toMatch(/history checks still run: trailers/);
    expect(field(statusCall(fake), "state")).toBe("failure");
  });

  it("remembers content checks even when a history check failed", async () => {
    const { d } = deps(
      [
        [/^sh -c pnpm run lint/, result(0)],
        [/^sh -c node tooling\/guards/, result(1)],
        ...gitRules(),
      ],
      config(steps),
    );
    expect((await runCiLocal(opts({ noStatus: true }), d)).verdict).toBe("fail");
    expect(passed()).toHaveLength(1);
  });

  it("writes the marker atomically, leaving no temporary file", async () => {
    await runCiLocal(opts({ noStatus: true }), deps([...ok, ...gitRules()], config(steps)).d);
    expect(passed().filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("the per-SHA lock", () => {
  const lockPath = () => join(root, ".ci-local", "locks", `${SHA}.lock`);
  const holdLock = (pid: number) => {
    mkdirSync(join(root, ".ci-local", "locks"), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid, host: "other", startedAt: "earlier" }));
  };

  it("two concurrent runs on one SHA serialise: the second waits, then reuses the first's pass", async () => {
    const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
    const a = deps(
      [[/^sh -c pnpm run lint/, result(0)], ...gitRules()],
      config([{ name: "lint", run: "pnpm run lint", applies: "always" }]),
      {},
      { sleep: realSleep, lockWaitMs: 60_000 },
    );
    const b = deps(
      [[/^sh -c pnpm run lint/, result(0)], ...gitRules()],
      config([{ name: "lint", run: "pnpm run lint", applies: "always" }]),
      {},
      { sleep: realSleep, lockWaitMs: 60_000 },
    );
    const [oa, ob] = await Promise.all([
      runCiLocal(opts({ noStatus: true }), a.d),
      runCiLocal(opts({ noStatus: true }), b.d),
    ]);
    expect(oa.verdict).toBe("pass");
    expect(ob.verdict).toBe("pass");
    expect([oa.reused, ob.reused].sort()).toEqual([false, true]);
    expect(a.out() + b.out()).toMatch(/waiting: pid \d+ on laptop has been testing aaaaaaaaaaaa/);
    expect(runDirs()).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("gives each run its own snapshot directory", async () => {
    const steps = [{ name: "lint", run: "pnpm run lint", applies: "always" as const }];
    const failing: Rule = [/^sh -c pnpm run lint/, result(1)];
    const o1 = await runCiLocal(
      opts({ noStatus: true }),
      deps([failing, ...gitRules()], config(steps)).d,
    );
    const o2 = await runCiLocal(
      opts({ noStatus: true }),
      deps([failing, ...gitRules()], config(steps)).d,
    );
    expect(o1.snapshot).not.toBe(o2.snapshot);
    // Neither run deleted the other's kept snapshot.
    expect(runDirs()).toHaveLength(2);
  });

  it("takes over a lock whose pid is dead, and says so", async () => {
    holdLock(999_999);
    const { d, out } = deps(gitRules(), config([]), {}, { isAlive: () => false });
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(o.verdict).toBe("pass");
    expect(out()).toMatch(/taking over a stale lock .*pid 999999 on other .* is not running/);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("takes over an unreadable lock", async () => {
    mkdirSync(join(root, ".ci-local", "locks"), { recursive: true });
    writeFileSync(lockPath(), "garbage");
    const { d, out } = deps(gitRules(), config([]));
    expect((await runCiLocal(opts({ noStatus: true }), d)).verdict).toBe("pass");
    expect(out()).toMatch(/stale lock .*unreadable/);
  });

  it("waits for a live holder, and refuses after the wait without touching its lock", async () => {
    holdLock(4242);
    let slept = 0;
    const { d, fake, out } = deps(
      gitRules(),
      config([]),
      {},
      {
        isAlive: () => true,
        lockWaitMs: 3000,
        sleep: async () => {
          slept++;
        },
      },
    );
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(o).toMatchObject({ exit: 2, verdict: null });
    expect(slept).toBe(3);
    expect(out()).toMatch(/waiting: pid 4242/);
    expect(out()).toMatch(/still being tested by pid 4242/);
    expect(existsSync(lockPath())).toBe(true);
    expect(fake.calls.some((c) => c.args[0] === "clone")).toBe(false);
  });

  it("proceeds once a live holder releases", async () => {
    holdLock(4242);
    const { d } = deps(
      gitRules(),
      config([]),
      {},
      {
        isAlive: () => true,
        sleep: async () => rmSync(lockPath(), { force: true }),
      },
    );
    expect((await runCiLocal(opts({ noStatus: true }), d)).verdict).toBe("pass");
  });
});

describe("posting the status", () => {
  it("says push first when GitHub does not have the SHA", async () => {
    const { d, out } = deps(
      gitRules({}, [[/^gh api/, result(1, "", "HTTP 422: No commit found for SHA")]]),
      config([]),
    );
    const o = await runCiLocal(opts(), d);
    expect(o).toMatchObject({ status: "push-first", exit: 1 });
    expect(out()).toMatch(/push first/);
  });

  it("reports could-not-ask when gh is missing", async () => {
    const { d } = deps(gitRules({}, [[/^gh api/, result(127)]]), config([]));
    expect(await runCiLocal(opts(), d)).toMatchObject({ status: "could-not-ask", exit: 2 });
  });

  it("--no-status asks GitHub nothing", async () => {
    const { d, fake } = deps(gitRules(), config([]));
    await runCiLocal(opts({ noStatus: true }), d);
    expect(statusCall(fake)).toBeUndefined();
  });
});

describe("applies", () => {
  const write = (rel: string, body = "") => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };

  it("has-apps and has-packages need a package.json one level down", () => {
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    expect(appliesTo("has-apps", root).ok).toBe(false);
    write("apps/web/package.json", "{}");
    expect(appliesTo("has-apps", root).ok).toBe(true);
    expect(appliesTo("has-packages", root).ok).toBe(false);
  });

  it("has-source ignores the starter's own tooling and config files", () => {
    write("tooling/ci/src/ci-local.mts");
    write("tooling/journeys/src/x.ts");
    write("sdlc.config.ts");
    write("node_modules/a/index.ts");
    expect(hasSource(root)).toBe(false);
    write("packages/core/src/index.ts");
    expect(hasSource(root)).toBe(true);
  });

  it("has-plan needs the README /plan writes, not the starter's placeholder", () => {
    write("docs/plan/README.md", "# Plan\n\nWritten by /plan.\n");
    expect(hasPlan(root)).toBe(false);
    write("docs/plan/README.md", "# Plan\n\n## Milestones\n\n- M1\n");
    expect(hasPlan(root)).toBe(true);
  });
});

describe("pure parts", () => {
  it("parseArgs", () => {
    expect(parseArgs(["--sha", "origin/dev", "--allow-unknown"])).toEqual({
      sha: "origin/dev",
      allowUnknown: true,
      noStatus: false,
    });
    expect(parseArgs(["--sha=abc", "--no-status"])).toEqual({
      sha: "abc",
      allowUnknown: false,
      noStatus: true,
    });
    expect(parseArgs(["--container"])).toEqual({
      allowUnknown: false,
      noStatus: false,
      container: true,
    });
    expect(parseArgs(["--sha"])).toHaveProperty("error");
    expect(parseArgs(["--bogus"])).toHaveProperty("error");
  });

  it("scrubbedEnv keeps only the essentials and what is declared", () => {
    expect(scrubbedEnv({ PATH: "p", AWS_SECRET: "x", HOME: "h" }, ["MISSING"])).toEqual({
      CI: "1",
      NODE_ENV: "test",
      PATH: "p",
      HOME: "h",
    });
  });

  it("verdictOf: fail beats unknown beats pass; n/a never holds", () => {
    const s = (state: "pass" | "fail" | "could-not-run" | "n/a") => ({
      name: "x",
      state,
      detail: "",
      ms: 0,
    });
    expect(verdictOf([s("pass"), s("n/a")])).toBe("pass");
    expect(verdictOf([s("pass"), s("could-not-run")])).toBe("unknown");
    expect(verdictOf([s("could-not-run"), s("fail")])).toBe("fail");
  });
});

describe("the CI definition comes from origin/<integration>", () => {
  const lint = { name: "lint", run: "pnpm run lint", applies: "always" as const };
  const lintOk: Rule = [/^sh -c pnpm run lint/, result(0)];

  it("reads the steps at the base commit, not the commit under test", async () => {
    const asked: string[] = [];
    const branchCfg = config([{ name: "sabotage", run: "exit 1", applies: "always" }]);
    const { d, fake } = deps(
      [lintOk, ...gitRules()],
      branchCfg,
      {},
      {
        loadConfigAt: async (_dir, ref) => (asked.push(ref), config([lint])),
      },
    );
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(asked).toEqual([BASE]);
    expect(o.verdict).toBe("pass");
    expect(o.steps.map((s) => s.name)).toEqual(["snapshot", "install", "lint"]);
    expect(fake.calls.some((c) => c.args.includes("exit 1"))).toBe(false);
  });

  it("warns when the commit changes sdlc.config.json, since that takes effect only after it lands", async () => {
    const { d, out } = deps(
      [lintOk, [/^git diff --quiet /, result(1)], ...gitRules()],
      config([lint]),
    );
    await runCiLocal(opts({ noStatus: true }), d);
    expect(out()).toMatch(/this commit changes sdlc\.config\.json.*only after it lands/);
  });

  it("says nothing about the config when the commit leaves it alone", async () => {
    const { d, out } = deps([lintOk, ...gitRules()], config([lint]));
    await runCiLocal(opts({ noStatus: true }), d);
    expect(out()).not.toMatch(/changes sdlc\.config\.json/);
  });

  it("falls back to the working tree's config when the base has none, and says so", async () => {
    const { d, out } = deps(
      [lintOk, ...gitRules()],
      config([lint]),
      {},
      {
        loadConfigAt: async () => null,
      },
    );
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(o.verdict).toBe("pass");
    expect(o.steps.map((s) => s.name)).toContain("lint");
    expect(out()).toMatch(/origin\/dev has no sdlc\.config\.json yet.*working tree/);
  });

  it("fails on a base config that does not validate, naming the problem", async () => {
    const { d, fake } = deps(
      gitRules(),
      config([lint]),
      {},
      {
        loadConfigAt: async () => {
          throw new Error(
            "sdlc.config.json at x is not a valid configuration:\n  ci.steps[0].applies: …",
          );
        },
      },
    );
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(o.verdict).toBe("fail");
    expect(o.steps.at(-1)).toMatchObject({ name: "config", state: "fail" });
    expect(o.steps.at(-1)?.detail).toMatch(/on origin\/dev did not load/);
    expect(fake.calls.some((c) => c.cmd === "sh")).toBe(false);
  });

  it("refuses when the working tree's config does not load", async () => {
    const { d } = deps(
      gitRules(),
      config([]),
      {},
      {
        loadConfig: async () => {
          throw new Error("unknown key");
        },
      },
    );
    const o = await runCiLocal(opts({ noStatus: true }), d);
    expect(o.verdict).toBeNull();
    expect(o.refusal).toMatch(/sdlc\.config\.json did not load: unknown key/);
  });
});

describe("--container", () => {
  const lint = {
    name: "lint",
    run: "pnpm run lint",
    applies: "always" as const,
    env: ["DECLARED"],
  };
  const withContainer = (engine?: "docker" | "podman") => {
    const c = config([lint]);
    c.ci.container = { image: "node:24", ...(engine ? { engine } : {}) };
    return c;
  };
  const dockerOk: Rule[] = [
    [/^docker --version$/, result(0, "Docker version 28\n")],
    [/^docker run /, result(0, "ok")],
  ];

  it("runs install and every step in the image: the snapshot mounted, no home, values off the command line", async () => {
    const { d, fake } = deps([...dockerOk, ...gitRules()], withContainer());
    const o = await runCiLocal(opts({ container: true, noStatus: true }), d);
    expect(o.verdict).toBe("pass");
    expect(o.steps.map((s) => [s.name, s.state])).toEqual([
      ["snapshot", "pass"],
      ["container", "pass"],
      ["install", "pass"],
      ["lint", "pass"],
    ]);
    const runs = fake.calls.filter((c) => c.cmd === "docker" && c.args[0] === "run");
    expect(runs.map((c) => c.args.at(-1))).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run lint",
    ]);
    const step = runs[1]!;
    const v = step.args[step.args.indexOf("-v") + 1] ?? "";
    expect(v).toMatch(new RegExp(`/\\.ci-local/run-${SHA}-[0-9a-f]{8}:/work$`));
    expect(step.args.filter((a) => a.includes(":/")).length).toBe(1); // one mount, the snapshot
    expect(step.args).toContain("node:24");
    // Names only: the value of a declared variable never reaches argv.
    expect(step.args).toContain("DECLARED");
    expect(step.args.join(" ")).not.toMatch(/yes|s3cret|\/home\/x/);
    expect(step.args).not.toContain("HOME");
    expect(step.args).not.toContain("SECRET");
    expect(step.opts.env).toMatchObject({ DECLARED: "yes", HOME: "/home/x" });
    expect(step.opts.env).not.toHaveProperty("SECRET");
    // No host pnpm, no offline store, and a clone the container can read.
    expect(fake.calls.some((c) => c.cmd === "pnpm" || c.cmd === "sh")).toBe(false);
    expect(fake.calls.find((c) => c.args[0] === "clone")?.args).not.toContain("--shared");
  });

  it("uses podman when the config says so", async () => {
    const { d, fake } = deps(
      [[/^podman --version$/, result(0)], [/^podman run /, result(0)], ...gitRules()],
      withContainer("podman"),
    );
    expect((await runCiLocal(opts({ container: true, noStatus: true }), d)).verdict).toBe("pass");
    expect(fake.calls.some((c) => c.cmd === "docker")).toBe(false);
  });

  it("an engine that is not installed is could-not-run, and holds the verdict", async () => {
    const { d, fake } = deps(gitRules(), withContainer());
    const o = await runCiLocal(opts({ container: true }), d);
    expect(o).toMatchObject({ exit: 2, verdict: "unknown" });
    expect(o.steps.at(-1)).toMatchObject({
      name: "container",
      state: "could-not-run",
      detail: "docker is not installed",
    });
    expect(fake.calls.some((c) => c.args[0] === "run" || c.cmd === "sh")).toBe(false);
  });

  it("--container with no ci.container declared is could-not-run", async () => {
    const { d } = deps(gitRules(), config([lint]));
    const o = await runCiLocal(opts({ container: true, noStatus: true }), d);
    expect(o.verdict).toBe("unknown");
    expect(o.steps.at(-1)?.detail).toMatch(/needs ci\.container\.image/);
  });

  it("a container that does not start (exit 125) is could-not-run, not a failure", async () => {
    const { d } = deps(
      [
        [/^docker --version$/, result(0)],
        [/^docker run .*pnpm install/, result(0)],
        [/^docker run /, result(125, "", "Unable to find image")],
        ...gitRules(),
      ],
      withContainer(),
    );
    const o = await runCiLocal(opts({ container: true, noStatus: true }), d);
    expect(o.verdict).toBe("unknown");
    expect(o.steps.at(-1)).toMatchObject({ name: "lint", state: "could-not-run" });
  });

  it("the image is part of the cache key; a host run's key is unchanged", () => {
    const parts = {
      tree: "t",
      steps: [],
      node: "v24",
      pnpm: "10",
      platform: "linux",
      arch: "x64",
      lockfile: "l",
      self: "s",
    };
    expect(cacheKey({ ...parts, container: undefined })).toBe(cacheKey(parts));
    expect(cacheKey({ ...parts, container: "docker:node:24" })).not.toBe(cacheKey(parts));
    expect(cacheKey({ ...parts, container: "docker:node:24" })).not.toBe(
      cacheKey({ ...parts, container: "docker:node:22" }),
    );
  });

  it("containerCommand passes --network only when one is declared", () => {
    const env = { CI: "1", PATH: "/bin", HOME: "/h", TOKEN: "t" };
    const host = { PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///x", SECRET: "s" };
    const a = containerCommand({ image: "i" }, "/snap", env, "echo hi", host);
    expect(a.cmd).toBe("docker");
    expect(a.args).not.toContain("--network");
    expect(a.args.slice(-4)).toEqual(["i", "sh", "-c", "echo hi"]);
    expect(a.env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      DOCKER_HOST: "unix:///x",
      CI: "1",
      TOKEN: "t",
    });
    const b = containerCommand({ image: "i", network: "none" }, "/snap", env, "x", host);
    expect(b.args.slice(2, 4)).toEqual(["--network", "none"]);
  });
});

describe("against a real git repository", () => {
  const gitIn = async (...args: string[]) => {
    const { exec } = await import("../../core/src/exec.mts");
    const r = await exec(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root },
    );
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const realDeps = async (lines: string[]): Promise<CiDeps> => {
    const { exec } = await import("../../core/src/exec.mts");
    const fake = async (cmd: string, args: string[], o?: Parameters<typeof exec>[2]) =>
      cmd === "pnpm" || cmd === "gh" ? result(0) : exec(cmd, args, o);
    return {
      exec: fake,
      root,
      loadConfig,
      loadConfigAt: (dir, ref) => loadConfigAt(dir, ref),
      host: "laptop",
      now: () => Date.now(),
      log: (l) => lines.push(l),
      env: process.env,
      stepTimeoutMs: 30_000,
      installTimeoutMs: 30_000,
    };
  };
  const step = {
    name: "history",
    // One commit ahead of origin/dev, and the committed file is there.
    run: 'test "$(git rev-list --count origin/dev..HEAD)" = 1 && test -f b.txt',
    applies: "always" as const,
  };

  it("snapshots a commit with history, reads the CI definition from origin/dev, and passes", async () => {
    await gitIn("init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), ".ci-local/\n");
    writeFileSync(join(root, "a.txt"), "one");
    writeFileSync(join(root, "sdlc.config.json"), JSON.stringify(config([step])));
    await gitIn("add", ".");
    await gitIn("commit", "-q", "--no-verify", "-m", "one");
    await gitIn("update-ref", "refs/remotes/origin/dev", "HEAD");
    // The branch rewrites its own gate to something that would fail. It must
    // not take effect: the definition is origin/dev's.
    writeFileSync(join(root, "b.txt"), "two");
    writeFileSync(
      join(root, "sdlc.config.json"),
      JSON.stringify(config([{ name: "sabotage", run: "exit 1", applies: "always" }])),
    );
    await gitIn("add", ".");
    await gitIn("commit", "-q", "--no-verify", "-m", "two");
    const head = await gitIn("rev-parse", "HEAD");

    const lines: string[] = [];
    const o = await runCiLocal(opts({ noStatus: true }), await realDeps(lines));
    expect(o.verdict, lines.join("\n")).toBe("pass");
    expect(o.sha).toBe(head);
    expect(o.steps.map((s) => s.name)).toEqual(["snapshot", "history"]);
    expect(lines.join("\n")).toMatch(/this commit changes sdlc\.config\.json/);
    expect(runDirs()).toEqual([]);
  });

  it("falls back to the working tree's config when origin/dev has none yet, and says so", async () => {
    await gitIn("init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), ".ci-local/\n");
    writeFileSync(join(root, "a.txt"), "one");
    await gitIn("add", ".");
    await gitIn("commit", "-q", "--no-verify", "-m", "one");
    await gitIn("update-ref", "refs/remotes/origin/dev", "HEAD");
    writeFileSync(join(root, "b.txt"), "two");
    writeFileSync(join(root, "sdlc.config.json"), JSON.stringify(config([step])));
    await gitIn("add", ".");
    await gitIn("commit", "-q", "--no-verify", "-m", "two");

    const lines: string[] = [];
    const o = await runCiLocal(opts({ noStatus: true }), await realDeps(lines));
    expect(o.verdict, lines.join("\n")).toBe("pass");
    expect(lines.join("\n")).toMatch(/origin\/dev has no sdlc\.config\.json yet/);
  });
});
