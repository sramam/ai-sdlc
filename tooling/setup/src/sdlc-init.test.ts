import { describe, expect, it } from "vitest";
import type { SdlcConfig } from "../../core/src/config.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult } from "../../core/src/exec.mts";
import { REPO_SETTINGS, runInit } from "./sdlc-init.mts";

const config = {
  branches: { integration: "dev", staging: "staging", production: "main" },
} as SdlcConfig;
const MAIN = "f".repeat(40);
type Rule = [RegExp | string, ExecResult];

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
  [/^gh api (-X|repos\/acme\/app\/git\/refs)/, result(0, "{}")],
  ["git fetch --prune origin", result(0)],
  ["git lfs version", result(0, "git-lfs/3.7.0")],
  [/^git config --local --get filter.lfs.clean/, result(1)],
  ["git lfs install --local", result(0)],
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
});
