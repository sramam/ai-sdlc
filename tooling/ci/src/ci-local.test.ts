import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SdlcConfig } from "../../core/src/config.mts";
import {
  appliesTo,
  hasPlan,
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
    [/^pnpm install --offline/, result(0)],
    [/^gh api repos\/\{owner\}\/\{repo\}\/statuses/, result(0, "{}")],
  ];
}

function deps(rules: Rule[], cfg: SdlcConfig, env: NodeJS.ProcessEnv = {}) {
  const fake = scriptedExec(rules);
  const lines: string[] = [];
  let t = 0;
  const d: CiDeps = {
    exec: fake,
    root,
    loadConfig: async () => cfg,
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
  };
  return { d, fake, lines, out: () => lines.join("\n") };
}

const opts = (o: Partial<CiOptions> = {}): CiOptions => ({
  allowUnknown: false,
  noStatus: false,
  ...o,
});
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
    expect(lint?.opts.cwd).toBe(join(root, ".ci-local", `run-${SHA}`));

    expect(existsSync(join(root, ".ci-local", "passed", TREE))).toBe(true);
    expect(existsSync(join(root, ".ci-local", `run-${SHA}`))).toBe(false);
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

  it("skips everything for a tree that already passed — the post-merge fingerprint", async () => {
    mkdirSync(join(root, ".ci-local", "passed"), { recursive: true });
    writeFileSync(join(root, ".ci-local", "passed", TREE), "{}");
    const { d, fake } = deps(gitRules(), config(steps));
    const o = await runCiLocal(opts({ sha: "HEAD" }), d);
    expect(o).toMatchObject({ exit: 0, verdict: "pass", reused: true, status: "posted" });
    expect(
      fake.calls.some((c) => c.args[0] === "clone" || c.cmd === "sh" || c.cmd === "pnpm"),
    ).toBe(false);
    expect(field(statusCall(fake), "description")).toMatch(/reused cccccc/);
  });

  it("fails, keeps the snapshot, posts failure and prints the step's output", async () => {
    const { d, fake, out } = deps(
      [[/^sh -c pnpm run lint/, result(1, "", "src/x.ts: 3 problems")], ...gitRules()],
      config(steps),
    );
    const o = await runCiLocal(opts(), d);
    expect(o).toMatchObject({ exit: 1, verdict: "fail" });
    expect(existsSync(join(root, ".ci-local", `run-${SHA}`))).toBe(true);
    expect(existsSync(join(root, ".ci-local", "passed", TREE))).toBe(false);
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

  it("--allow-unknown posts success with the override in the description, and remembers nothing", async () => {
    const { d, fake } = deps([[/^sh -c pnpm run lint/, result(127)], ...gitRules()], config(steps));
    const o = await runCiLocal(opts({ allowUnknown: true }), d);
    expect(o.exit).toBe(0);
    expect(field(statusCall(fake), "state")).toBe("success");
    expect(field(statusCall(fake), "description")).toMatch(/allow-unknown: lint/);
    expect(existsSync(join(root, ".ci-local", "passed", TREE))).toBe(false);
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

describe("against a real git repository", () => {
  it("snapshots a commit with history, ignoring uncommitted-but-ignored files, and passes", async () => {
    const { exec } = await import("../../core/src/exec.mts");
    const g = async (...args: string[]) => {
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
    await g("init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), ".ci-local/\n");
    writeFileSync(join(root, "a.txt"), "one");
    await g("add", ".");
    await g("commit", "-q", "--no-verify", "-m", "one");
    await g("update-ref", "refs/remotes/origin/dev", "HEAD");
    writeFileSync(join(root, "b.txt"), "two");
    await g("add", "b.txt");
    await g("commit", "-q", "--no-verify", "-m", "two");
    const head = await g("rev-parse", "HEAD");

    const fake = async (cmd: string, args: string[], o?: Parameters<typeof exec>[2]) =>
      cmd === "pnpm" || cmd === "gh" ? result(0) : exec(cmd, args, o);
    const lines: string[] = [];
    const step = {
      name: "history",
      // One commit ahead of origin/dev, and the committed file is there.
      run: 'test "$(git rev-list --count origin/dev..HEAD)" = 1 && test -f b.txt',
      applies: "always" as const,
    };
    const o = await runCiLocal(opts({ noStatus: true }), {
      exec: fake,
      root,
      loadConfig: async () => config([step]),
      host: "laptop",
      now: () => Date.now(),
      log: (l) => lines.push(l),
      env: process.env,
      stepTimeoutMs: 30_000,
      installTimeoutMs: 30_000,
    });
    expect(o.verdict, lines.join("\n")).toBe("pass");
    expect(o.sha).toBe(head);
    expect(existsSync(join(root, ".ci-local", `run-${head}`))).toBe(false);
  });
});
