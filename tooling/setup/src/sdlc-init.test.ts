import { describe, expect, it } from "vitest";
import type { SdlcConfig } from "../../core/src/config.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult, ScriptedCall } from "../../core/src/exec.mts";
import { readFileSync } from "node:fs";
import {
  REPO_SETTINGS,
  RULESET_NAME,
  RULESET_UNAVAILABLE,
  covers,
  integrationRuleset,
  runInit,
} from "./sdlc-init.mts";

const config = {
  branches: { integration: "dev", staging: "staging", production: "main" },
} as SdlcConfig;
const MAIN = "f".repeat(40);
type Rule = [RegExp | string, ExecResult | ((call: ScriptedCall) => ExecResult)];

const fresh: Rule[] = [
  [
    /^gh repo view/,
    result(0, JSON.stringify({ nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } })),
  ],
  [/^gh api repos\/acme\/app\/branches\/dev$/, result(1, "", "gh: Branch not found (HTTP 404)")],
  [/^gh api repos\/acme\/app\/git\/ref\/heads\/main/, result(0, `${MAIN}\n`)],
  [
    /^gh api repos\/acme\/app$/,
    result(
      0,
      JSON.stringify({ allow_squash_merge: true, allow_merge_commit: true, has_issues: true }),
    ),
  ],
  [/^gh api repos\/acme\/app\/actions\/permissions$/, result(0, JSON.stringify({ enabled: true }))],
  [/^gh api repos\/acme\/app\/rulesets$/, result(0, "[]")],
  [/^gh api (-X|repos\/acme\/app\/git\/refs)/, result(0, "{}")],
  ["git fetch --prune origin", result(0)],
  ["git lfs version", result(0, "git-lfs/3.7.0")],
  [/^git config --local --get filter.lfs.clean/, result(1)],
  ["git lfs install --local", result(0)],
  [/^git check-attr filter -- /, result(0, "docs/journeys/x.png: filter: lfs\n")],
  [/^node .*bootstrap\.mts$/, result(0, "  ok node")],
  [/^node .*ci-local\.mts --no-status$/, result(0, "  verdict: pass")],
];

const configured: Rule[] = [
  [
    /^gh repo view/,
    result(0, JSON.stringify({ nameWithOwner: "acme/app", defaultBranchRef: { name: "dev" } })),
  ],
  [/^gh api repos\/acme\/app\/branches\/dev$/, result(0, "{}")],
  [/^gh api repos\/acme\/app$/, result(0, JSON.stringify(REPO_SETTINGS))],
  [
    /^gh api repos\/acme\/app\/actions\/permissions$/,
    result(0, JSON.stringify({ enabled: false })),
  ],
  [/^git config --local --get filter.lfs.clean/, result(0, "git-lfs clean -- %f")],
  [
    /^gh api repos\/acme\/app\/rulesets$/,
    result(0, JSON.stringify([{ id: 7, name: RULESET_NAME }])),
  ],
  [
    /^gh api repos\/acme\/app\/rulesets\/7$/,
    // GitHub answers with more than was sent; only what was asked for is compared.
    result(
      0,
      JSON.stringify({
        id: 7,
        ...integrationRuleset("dev"),
        source: "acme/app",
        bypass_actors: [],
      }),
    ),
  ],
  ...fresh.filter(([p]) => !String(p).includes("gh ")),
];

const run = async (rules: Rule[], dryRun = false) => {
  const exec = scriptedExec(rules);
  const lines: string[] = [];
  const out = await runInit({ exec, root: "/repo", config, dryRun, log: (l) => lines.push(l) });
  const state = Object.fromEntries(out.steps.map((s) => [s.name, s.state]));
  return { ...out, exec, lines, state };
};

describe("sdlc:init", () => {
  it("on a fresh repository: creates dev through the API, never by pushing, and applies settings", async () => {
    const { exit, exec, state } = await run(fresh);
    expect(exit).toBe(0);
    expect(state).toMatchObject({
      repository: "already",
      "integration branch": "done",
      "default branch": "done",
      settings: "done",
      actions: "done",
      fetch: "done",
      "git-lfs": "done",
      "lfs patterns": "already",
      ruleset: "done",
      bootstrap: "done",
      "ci:local": "done",
    });
    const lines = exec.calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(lines).toContain(`gh api repos/acme/app/git/refs -f ref=refs/heads/dev -f sha=${MAIN}`);
    expect(lines.some((l) => l.startsWith("git push"))).toBe(false);
    expect(lines).toContain("gh api -X PATCH repos/acme/app -f default_branch=dev");
    // Only the settings that differ are sent.
    const patch = lines.find((l) => l.includes("PATCH repos/acme/app -F"));
    expect(patch).toContain("allow_squash_merge=false");
    expect(patch).not.toContain("allow_merge_commit");
    expect(lines).toContain("gh api -X PUT repos/acme/app/actions/permissions -F enabled=false");
  });

  it("is idempotent: a configured repository reports already and changes nothing", async () => {
    const { exit, exec, state } = await run(configured);
    expect(exit).toBe(0);
    expect(state).toMatchObject({
      "integration branch": "already",
      "default branch": "already",
      settings: "already",
      actions: "already",
      "git-lfs": "already",
      ruleset: "already",
    });
    expect(exec.calls.some((c) => c.args.includes("-X") || c.args.includes("install"))).toBe(false);
  });

  it("--dry-run reads but changes nothing", async () => {
    const { exec, state } = await run(fresh, true);
    expect(state).toMatchObject({
      "integration branch": "would",
      settings: "would",
      actions: "would",
      fetch: "would",
      bootstrap: "would",
      "ci:local": "would",
    });
    const mutating = exec.calls.filter(
      (c) =>
        c.args.includes("-X") ||
        c.args.includes("fetch") ||
        c.args.includes("install") ||
        c.args.includes("-f"),
    );
    expect(mutating).toEqual([]);
  });

  it("with no GitHub repository, reports could-not-ask for every GitHub step", async () => {
    const { exit, state, lines } = await run(
      [[/^gh repo view/, result(1, "", "no git remotes found")], ...configured.slice(4)],
      true,
    );
    expect(exit).toBe(1);
    expect(state).toMatchObject({
      repository: "could-not-ask",
      "integration branch": "could-not-ask",
      actions: "could-not-ask",
    });
    expect(lines.join("\n")).toMatch(/no git remotes found/);
  });

  it("refuses to invent dev when main has no commit on GitHub", async () => {
    const rules: Rule[] = [
      [
        /^gh api repos\/acme\/app\/git\/ref\/heads\/main/,
        result(1, "", "HTTP 409: Git Repository is empty."),
      ],
      ...fresh,
    ];
    const { state, steps } = await run(rules);
    expect(state["integration branch"]).toBe("failed");
    expect(steps.find((s) => s.name === "integration branch")?.detail).toMatch(/push main first/);
  });

  it("reports a missing git-lfs as failed", async () => {
    const { state } = await run([
      ["git lfs version", result(1, "", "git: 'lfs' is not a git command.")],
      ...configured,
    ]);
    expect(state["git-lfs"]).toBe("failed");
  });

  it("verifies .gitattributes routes journey evidence to LFS, not only that git-lfs exists", async () => {
    const { state, exit, steps } = await run([
      [/^git check-attr filter -- /, result(0, "docs/journeys/x.png: filter: unspecified\n")],
      ...configured,
    ]);
    expect(state["git-lfs"]).toBe("already");
    expect(state["lfs patterns"]).toBe("failed");
    expect(steps.find((s) => s.name === "lfs patterns")?.detail).toMatch(/filter=lfs/);
    expect(exit).toBe(1);
  });
});

describe("the integration ruleset", () => {
  const rulesetCalls = (exec: { calls: Array<{ args: string[] }> }) =>
    exec.calls.filter((c) => c.args.some((a) => a.includes("rulesets"))).map((c) => c.args);

  it("creates it with a pull request and the local-ci check, through --input", async () => {
    let body: unknown = null;
    const { state, exec } = await run([
      [
        /^gh api -X POST repos\/acme\/app\/rulesets --input /,
        (call) => {
          body = JSON.parse(readFileSync(call.args.at(-1)!, "utf8"));
          return result(0, "{}");
        },
      ],
      ...fresh,
    ]);
    expect(state.ruleset).toBe("done");
    expect(body).toEqual(integrationRuleset("dev"));
    expect(JSON.stringify(body)).toContain('"context":"local-ci"');
    expect(JSON.stringify(body)).toContain("refs/heads/dev");
    expect(rulesetCalls(exec).map((a) => a.slice(0, 4).join(" "))).toEqual([
      "api repos/acme/app/rulesets",
      "api -X POST repos/acme/app/rulesets",
    ]);
  });

  it("is already present when one by that name covers what is asked", async () => {
    const { state, exec } = await run(configured);
    expect(state.ruleset).toBe("already");
    expect(rulesetCalls(exec).some((a) => a.includes("-X"))).toBe(false);
  });

  it("updates one by that name that has drifted", async () => {
    const drifted = { id: 7, ...integrationRuleset("dev"), rules: [] };
    const { state, exec } = await run([
      [/^gh api repos\/acme\/app\/rulesets\/7$/, result(0, JSON.stringify(drifted))],
      [/^gh api -X PUT repos\/acme\/app\/rulesets\/7 --input /, result(0, "{}")],
      ...configured,
    ]);
    expect(state.ruleset).toBe("done");
    expect(rulesetCalls(exec).some((a) => a.includes("PUT"))).toBe(true);
  });

  it("is unavailable, not failed, when the plan refuses (403 or 404)", async () => {
    for (const rules of [
      [
        [
          /^gh api repos\/acme\/app\/rulesets$/,
          result(
            1,
            "",
            "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
          ),
        ],
      ],
      [[/^gh api -X POST repos\/acme\/app\/rulesets/, result(1, "", "gh: Not Found (HTTP 404)")]],
    ] as Rule[][]) {
      const { state, steps, exit } = await run([...rules, ...fresh]);
      expect(state.ruleset).toBe("unavailable");
      expect(steps.find((s) => s.name === "ruleset")?.detail).toBe(RULESET_UNAVAILABLE);
      expect(exit).toBe(0);
    }
  });

  it("fails on any other refusal", async () => {
    const { state, exit } = await run([
      [
        /^gh api -X POST repos\/acme\/app\/rulesets/,
        result(1, "", "gh: Validation Failed (HTTP 422)"),
      ],
      ...fresh,
    ]);
    expect(state.ruleset).toBe("failed");
    expect(exit).toBe(1);
  });

  it("--dry-run reads the rulesets and says what it would do", async () => {
    const { state, exec } = await run(fresh, true);
    expect(state.ruleset).toBe("would");
    expect(rulesetCalls(exec).every((a) => !a.includes("-X"))).toBe(true);
  });

  it("covers ignores GitHub's extra fields but not a missing or different one", () => {
    const want = integrationRuleset("dev");
    expect(covers({ ...want, id: 1, extra: true }, want)).toBe(true);
    expect(covers({ ...want, enforcement: "evaluate" }, want)).toBe(false);
    expect(covers({ ...want, rules: want.rules }, { ...want, name: "other" })).toBe(false);
  });
});
