import { describe, expect, it } from "vitest";
import { exampleConfig } from "../../core/src/config.test-helper.mts";
import type { EnvironmentConfig, SdlcConfig } from "../../core/src/config.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult, ScriptedCall } from "../../core/src/exec.mts";
import { parsePromoteArgs, runPromote } from "./promote.mts";
import type { PromoteDeps, PromoteOptions } from "./promote.mts";

const SRC = "a".repeat(40);
const TGT = "b".repeat(40);
const OLD = "c".repeat(40);
const TMP = "/tmp/promote-test";
const CHECKOUT = `${TMP}/checkout`;

type Rule = [RegExp | string, ExecResult | ((c: ScriptedCall) => ExecResult)];

const STAGING: EnvironmentConfig = {
  branch: "staging",
  deploy: "pnpm exec wrangler deploy --env staging",
  migrate: "pnpm run db:migrate:staging",
  smokeUrl: "https://staging.example.com/api/health",
  rollback: "pnpm exec wrangler rollback --env staging",
};

function config(envs: Record<string, EnvironmentConfig> = { staging: STAGING }): SdlcConfig {
  return exampleConfig((c) => (c.environments = envs));
}

const status = (statuses: Array<{ context: string; state: string }>) =>
  result(0, JSON.stringify({ state: "success", statuses }));
const GREEN = status([{ context: "local-ci", state: "success" }]);

/** Every precondition holds and every command succeeds. `over` rules win. */
function happy(over: Rule[] = []): Rule[] {
  return [
    ...over,
    ["git status --porcelain", result(0, "")],
    ["git fetch --quiet origin", result(0)],
    [/^git rev-parse --verify --quiet origin\/dev\^\{commit\}$/, result(0, `${SRC}\n`)],
    [/^git rev-parse --verify --quiet origin\/staging\^\{commit\}$/, result(0, `${TGT}\n`)],
    [/^git rev-parse --verify --quiet origin\/main\^\{commit\}$/, result(0, `${OLD}\n`)],
    [/^gh api repos\/\{owner\}\/\{repo\}\/commits\/\w+\/status$/, GREEN],
    [/^git merge-base --is-ancestor/, result(0)],
    [/^git rev-list --count/, result(0, "3\n")],
    [/^git push --dry-run --porcelain origin/, result(0)],
    [/^git clone --quiet --shared --no-checkout/, result(0)],
    [/^git checkout --quiet --detach/, result(0)],
    [/^pnpm install --offline --frozen-lockfile$/, result(0)],
    [/^sh -c /, result(0)],
    [/^git push --porcelain origin/, result(0)],
  ];
}

function deps(
  rules: Rule[],
  cfg: SdlcConfig = config(),
  http: PromoteDeps["httpGet"] = async () => ({ status: 200 }),
  arm: PromoteDeps["armPush"] | null = null,
) {
  const exec = scriptedExec(rules);
  const lines: string[] = [];
  const removed: string[] = [];
  const gets: string[] = [];
  /** Every handoff armed, and whether it was withdrawn. */
  const armed: Array<{ sha: string; ref: string; nonce: string; disarmed: boolean }> = [];
  const d: PromoteDeps = {
    exec,
    root: "/repo",
    loadConfig: async () => cfg,
    log: (l) => lines.push(l),
    tempDir: () => TMP,
    removeDir: (dir) => removed.push(dir),
    exists: (p) => p === `${CHECKOUT}/pnpm-lock.yaml`,
    httpGet: async (url) => (gets.push(url), http(url)),
    armPush:
      arm ??
      (async (sha, ref) => {
        const h = { sha, ref, nonce: `nonce-${armed.length + 1}`, disarmed: false };
        armed.push(h);
        return { nonce: h.nonce, disarm: () => void (h.disarmed = true) };
      }),
  };
  const lineOf = (cmd: ScriptedCall) => [cmd.cmd, ...cmd.args].join(" ");
  return {
    d,
    lines,
    removed,
    gets,
    armed,
    calls: () => exec.calls.map(lineOf),
    sh: () => exec.calls.filter((c) => c.cmd === "sh").map((c) => c.args[1]),
    callsOf: (cmd: string) => exec.calls.filter((c) => c.cmd === cmd),
    out: () => lines.join("\n"),
  };
}

const opts = (o: Partial<PromoteOptions> = {}): PromoteOptions => ({
  env: "staging",
  dryRun: false,
  yes: false,
  ...o,
});

describe("parsePromoteArgs", () => {
  it("reads the environment and the flags", () => {
    expect(parsePromoteArgs(["staging"])).toEqual({
      env: "staging",
      sha: undefined,
      dryRun: false,
      yes: false,
    });
    expect(parsePromoteArgs(["--", "production", "--sha", "abc", "--dry-run", "--yes"])).toEqual({
      env: "production",
      sha: "abc",
      dryRun: true,
      yes: true,
    });
  });
  it("refuses a missing environment, a bare --sha and an unknown flag", () => {
    expect(parsePromoteArgs([])).toHaveProperty("error");
    expect(parsePromoteArgs(["staging", "--sha"])).toHaveProperty("error");
    expect(parsePromoteArgs(["staging", "--force"])).toHaveProperty("error");
    expect(parsePromoteArgs(["staging", "production"])).toHaveProperty("error");
  });
});

describe("runPromote", () => {
  it("promotes in order: checks, migrate, deploy in the checkout, push, smoke", async () => {
    const t = deps(happy());
    const o = await runPromote(opts(), t.d);
    expect(o).toEqual({ exit: 0, sha: SRC, deployed: true, pushed: true });
    const calls = t.calls();
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c));
    const order = [
      /^git status/,
      /^git fetch/,
      /^gh api .*\/status$/,
      /^git push --dry-run/,
      /^git clone/,
      /^git checkout/,
      /^pnpm install/,
      /^sh -c pnpm run db:migrate:staging$/,
      /^sh -c pnpm exec wrangler deploy --env staging$/,
      /^git push --porcelain origin/,
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The exact SHA, the clean checkout, the push form, the source's status.
    expect(calls).toContain(`gh api repos/{owner}/{repo}/commits/${SRC}/status`);
    expect(calls).toContain(`git clone --quiet --shared --no-checkout /repo ${CHECKOUT}`);
    expect(calls).toContain(`git checkout --quiet --detach ${SRC}`);
    expect(calls).toContain(`git push --porcelain origin ${SRC}:refs/heads/staging`);
    expect(calls.some((c) => /--force|-f\b|merge (?!-base)/.test(c))).toBe(false);
    for (const c of t.callsOf("sh")) {
      expect(c.opts.cwd).toBe(CHECKOUT);
      expect(c.opts.env?.PROMOTE_SHA).toBe(SRC);
    }
    expect(t.callsOf("git").find((c) => c.args[0] === "checkout")?.opts.cwd).toBe(CHECKOUT);
    expect(t.gets).toEqual([STAGING.smokeUrl]);
    expect(t.removed).toEqual([TMP]);
    expect(t.out()).toMatch(/ok\s+smoke\s+GET https:\/\/staging\.example\.com\/api\/health → 200/);
  });

  it("production promotes from the staging tip, not the integration branch", async () => {
    const prod: EnvironmentConfig = { branch: "main", deploy: "deploy-prod" };
    const t = deps(
      happy([
        [/^git rev-parse --verify --quiet origin\/staging\^\{commit\}$/, result(0, `${SRC}\n`)],
      ]),
      config({ production: prod }),
    );
    const o = await runPromote(opts({ env: "production" }), t.d);
    expect(o.exit).toBe(0);
    expect(t.calls()).toContain(`git merge-base --is-ancestor ${OLD} ${SRC}`);
    expect(t.calls()).toContain(`git push --porcelain origin ${SRC}:refs/heads/main`);
    expect(t.calls().some((c) => c.includes("origin/dev"))).toBe(false);
  });

  it("refuses an unknown environment and a dirty tree, touching nothing", async () => {
    const a = deps(happy());
    expect((await runPromote(opts({ env: "qa" }), a.d)).stoppedAt).toBe("config");
    expect(a.out()).toMatch(/no environment "qa".*known: staging/);
    const b = deps(happy([["git status --porcelain", result(0, " M x.ts\n")]]));
    const o = await runPromote(opts(), b.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "clean", deployed: false, pushed: false });
    expect(b.calls()).toEqual(["git status --porcelain"]);
  });

  it.each([
    ["absent", [], 1, /no local-ci status/],
    [
      "only the override",
      [{ context: "local-ci/allow-unknown", state: "success" }],
      1,
      /override is not a pass/,
    ],
    ["failure", [{ context: "local-ci", state: "failure" }], 1, /local-ci failure/],
    ["error (a held unknown)", [{ context: "local-ci", state: "error" }], 1, /local-ci is error/],
    ["pending", [{ context: "local-ci", state: "pending" }], 1, /local-ci is pending/],
    [
      "a lookalike context",
      [{ context: "local-ci-old", state: "success" }],
      1,
      /no local-ci status/,
    ],
  ])("refuses when local-ci is %s, before anything changes", async (_n, statuses, exit, msg) => {
    const t = deps(happy([[/^gh api/, status(statuses)]]));
    const o = await runPromote(opts(), t.d);
    expect(o).toMatchObject({ exit, stoppedAt: "local-ci" });
    expect(t.out()).toMatch(msg);
    expect(t.sh()).toEqual([]);
    expect(t.calls().some((c) => c.startsWith("git push"))).toBe(false);
  });

  it("could not ask GitHub: exit 2", async () => {
    const t = deps(happy([[/^gh api/, result(127)]]));
    expect(await runPromote(opts(), t.d)).toMatchObject({ exit: 2, stoppedAt: "local-ci" });
  });

  it("refuses anything but a fast-forward, before migrating", async () => {
    const t = deps(happy([[`git merge-base --is-ancestor ${TGT} ${SRC}`, result(1)]]));
    const o = await runPromote(opts(), t.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "ff" });
    expect(t.out()).toMatch(/not a fast-forward/);
    expect(t.sh()).toEqual([]);
  });

  it("names the pre-push hook when it refuses the dry-run push", async () => {
    const t = deps(
      happy([
        [
          /^git push --dry-run/,
          result(1, "", "pre-push: refusing to push staging directly.\nerror: failed to push"),
        ],
      ]),
    );
    const o = await runPromote(opts(), t.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "push-check" });
    expect(t.out()).toMatch(/pre-push hook refuses `git push origin a+:refs\/heads\/staging`/);
    expect(t.sh()).toEqual([]);
  });

  it("--sha must be on the source branch", async () => {
    const other = "d".repeat(40);
    const t = deps(
      happy([
        [/^git rev-parse --verify --quiet abc\^\{commit\}$/, result(0, `${other}\n`)],
        [`git merge-base --is-ancestor ${other} ${SRC}`, result(1)],
      ]),
    );
    const o = await runPromote(opts({ sha: "abc" }), t.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "source" });
    expect(t.out()).toMatch(/is not on origin\/dev/);
  });

  it("--sha on the source branch is what gets checked, deployed and pushed", async () => {
    const older = "d".repeat(40);
    const t = deps(
      happy([[/^git rev-parse --verify --quiet abc\^\{commit\}$/, result(0, `${older}\n`)]]),
    );
    expect((await runPromote(opts({ sha: "abc" }), t.d)).exit).toBe(0);
    expect(t.calls()).toContain(`gh api repos/{owner}/{repo}/commits/${older}/status`);
    expect(t.calls()).toContain(`git checkout --quiet --detach ${older}`);
    expect(t.calls()).toContain(`git push --porcelain origin ${older}:refs/heads/staging`);
  });

  it("--dry-run runs every check and changes nothing", async () => {
    const t = deps(happy());
    const o = await runPromote(opts({ dryRun: true }), t.d);
    expect(o).toEqual({ exit: 0, sha: SRC, deployed: false, pushed: false });
    expect(t.sh()).toEqual([]);
    expect(t.calls().filter((c) => c.startsWith("git push"))).toEqual([
      `git push --dry-run --porcelain origin ${SRC}:refs/heads/staging`,
    ]);
    expect(t.out()).toMatch(/plan\s+approval\s+deploy: pnpm exec wrangler deploy --env staging/);
  });

  it("requiresApproval prints the plan and stops without --yes; --yes proceeds", async () => {
    const cfg = config({ staging: { ...STAGING, requiresApproval: true } });
    const a = deps(happy(), cfg);
    const o = await runPromote(opts(), a.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "approval", deployed: false });
    expect(a.sh()).toEqual([]);
    expect(a.out()).toMatch(/re-run with --yes: pnpm promote staging --yes/);
    const b = deps(happy(), cfg);
    expect((await runPromote(opts({ yes: true }), b.d)).exit).toBe(0);
  });

  it("a failed migration stops before deploy and push", async () => {
    const t = deps(happy([[/^sh -c pnpm run db:migrate/, result(1, "", "boom")]]));
    const o = await runPromote(opts(), t.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "migrate", deployed: false, pushed: false });
    expect(t.sh()).toEqual(["pnpm run db:migrate:staging"]);
    expect(t.calls().some((c) => c.startsWith("git push --porcelain"))).toBe(false);
    expect(t.removed).toEqual([TMP]);
  });

  it("a failed deploy does not move the branch", async () => {
    const t = deps(happy([[/^sh -c pnpm exec wrangler deploy/, result(1)]]));
    const o = await runPromote(opts(), t.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "deploy", deployed: false, pushed: false });
    expect(t.out()).toMatch(/schema is forward/);
    expect(t.calls().some((c) => c.startsWith("git push --porcelain"))).toBe(false);
  });

  it("a failing smoke check fails loudly, after the push, naming the rollback", async () => {
    const t = deps(happy(), config(), async () => ({ status: 503 }));
    const o = await runPromote(opts(), t.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "smoke", deployed: true, pushed: true });
    expect(t.out()).toMatch(/answered 503 .* broken\. Roll back with: pnpm rollback staging/);
  });

  it("an unreachable smoke URL is could-not-ask, never a pass", async () => {
    const t = deps(happy(), config(), async () => ({ error: "ECONNREFUSED" }));
    expect(await runPromote(opts(), t.d)).toMatchObject({ exit: 2, stoppedAt: "smoke" });
    expect(t.out()).toMatch(/NOT confirmed working/);
  });

  it("a smoke command runs in the checkout; with no smoke at all it says so", async () => {
    const a = deps(
      happy([[/^sh -c ./, result(0)]]),
      config({ staging: { branch: "staging", deploy: "d", smoke: "pnpm smoke" } }),
    );
    expect((await runPromote(opts(), a.d)).exit).toBe(0);
    expect(a.sh()).toEqual(["d", "pnpm smoke"]);
    expect(a.gets).toEqual([]);
    const b = deps(happy(), config({ staging: { branch: "staging", deploy: "d" } }));
    expect((await runPromote(opts(), b.d)).exit).toBe(0);
    expect(b.out()).toMatch(/warn\s+smoke\s+none configured/);
    expect(b.out()).toMatch(/n\/a\s+migrate/);
  });

  it("nothing to promote when the target already has the SHA", async () => {
    const t = deps(
      happy([[/^git rev-parse --verify --quiet origin\/staging/, result(0, `${SRC}\n`)]]),
    );
    expect(await runPromote(opts(), t.d)).toEqual({
      exit: 0,
      sha: SRC,
      deployed: false,
      pushed: false,
    });
    expect(t.out()).toMatch(/nothing to promote/);
  });

  it("a first promotion creates the target branch", async () => {
    const t = deps(happy([[/^git rev-parse --verify --quiet origin\/staging/, result(1)]]));
    expect((await runPromote(opts(), t.d)).exit).toBe(0);
    expect(t.out()).toMatch(/does not exist yet/);
  });

  it("hands each push to the pre-push hook: exact SHA and ref, its own nonce, withdrawn after", async () => {
    const t = deps(happy());
    expect((await runPromote(opts(), t.d)).exit).toBe(0);
    expect(t.armed).toEqual([
      { sha: SRC, ref: "refs/heads/staging", nonce: "nonce-1", disarmed: true },
      { sha: SRC, ref: "refs/heads/staging", nonce: "nonce-2", disarmed: true },
    ]);
    const pushes = t.callsOf("git").filter((c) => c.args[0] === "push");
    expect(pushes.map((c) => c.opts.env?.SDLC_PROMOTE_NONCE)).toEqual(["nonce-1", "nonce-2"]);
    // Nothing else git runs carries a nonce.
    const others = t.callsOf("git").filter((c) => c.args[0] !== "push");
    expect(others.some((c) => c.opts.env?.SDLC_PROMOTE_NONCE)).toBe(false);
  });

  it("could not write the handoff: could-not-ask at push-check, nothing deployed", async () => {
    const t = deps(happy(), config(), undefined, async () => ({ error: "read-only .git" }));
    const o = await runPromote(opts(), t.d);
    expect(o).toMatchObject({ exit: 2, stoppedAt: "push-check", deployed: false });
    expect(t.out()).toMatch(/could not hand the push to the pre-push hook: read-only \.git/);
    expect(t.calls().some((c) => c.startsWith("git push"))).toBe(false);
    expect(t.sh()).toEqual([]);
  });

  it("a rejected push after deploy says the environment and the branch now disagree", async () => {
    const t = deps(happy([[/^git push --porcelain origin/, result(1, "", "rejected")]]));
    const o = await runPromote(opts(), t.d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "push", deployed: true, pushed: false });
    expect(t.out()).toMatch(/staging now runs a+ while staging still names b+/);
  });
});
