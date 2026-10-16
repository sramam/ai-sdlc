import { describe, expect, it } from "vitest";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult } from "../../core/src/exec.mts";
import { UPSTREAM_PATHS, runUpdate } from "./sdlc-update.mts";

type Rule = [RegExp | string, ExecResult];
const base: Rule[] = [
  ["git status --porcelain", result(0, "")],
  ["git remote get-url starter", result(0, "https://github.com/acme/starter.git\n")],
  ["git fetch --quiet starter", result(0)],
  [/^git rev-parse --verify --quiet starter\/main/, result(0, "1234567890abcdef\n")],
  [/^git ls-tree --name-only starter\/main -- tooling\/journeys$/, result(0, "")],
  [/^git ls-files -- tooling\/journeys\/$/, result(0, "")],
  [/^git ls-tree/, result(0, "x\n")],
  [/^git ls-files/, result(0, "")],
  [/^git restore/, result(0)],
  [/^git diff --stat/, result(0, " tooling/ci/src/ci-local.mts | 4 ++--\n 1 file changed\n")],
  [
    /^git status --porcelain --untracked-files=all/,
    result(0, " M tooling/ci/src/ci-local.mts\n?? docs/kit/new.md\n"),
  ],
];

const run = async (rules: Rule[]) => {
  const exec = scriptedExec(rules);
  const lines: string[] = [];
  const code = await runUpdate({ exec, root: "/repo", log: (l) => lines.push(l) });
  return { code, exec, out: lines.join("\n") };
};

describe("sdlc:update", () => {
  it("restores the upstream paths into the working tree only, and shows the diff", async () => {
    const { code, exec, out } = await run(base);
    expect(code).toBe(0);
    const restore = exec.calls.find((c) => c.args[0] === "restore");
    expect(restore?.args).toContain("--worktree");
    expect(restore?.args).not.toContain("--staged");
    expect(restore?.args).toContain(".claude/skills/land/");
    // A path on neither side is left out rather than failing the restore.
    expect(restore?.args).not.toContain("tooling/journeys/");
    expect(out).toMatch(/1 file changed/);
    expect(out).toMatch(/\?\? docs\/kit\/new\.md/);
    expect(exec.calls.some((c) => c.args[0] === "commit" || c.args[0] === "add")).toBe(false);
  });

  it("covers exactly the upstream-owned paths", () => {
    expect(UPSTREAM_PATHS).toContain("tooling/guards/");
    expect(UPSTREAM_PATHS).toContain("docs/kit/");
    expect(UPSTREAM_PATHS).toContain(".claude/skills/code-reviewer/");
    expect(UPSTREAM_PATHS).toHaveLength(17);
  });

  it("refuses a dirty tree", async () => {
    const { code, out } = await run([
      ["git status --porcelain", result(0, " M README.md\n")],
      ...base,
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/dirty/);
  });

  it("says how to add a missing starter remote", async () => {
    const { code, out } = await run([
      ["git remote get-url starter", result(2, "", "error: No such remote 'starter'")],
      ...base,
    ]);
    expect(code).toBe(1);
    expect(out).toMatch(/git remote add starter https:\/\/github\.com\/<org>\/<starter>\.git/);
  });

  it("reports already current when nothing differs", async () => {
    const { code, out } = await run([
      [/^git status --porcelain --untracked-files=all/, result(0, "")],
      ...base,
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/already current/);
  });
});
