import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exampleConfigJson } from "../../core/src/config.test-helper.mts";
import { integrationBranch, verdict } from "./worktree-base.mts";

const bash = (command: string, integration?: string) =>
  verdict({ tool_name: "Bash", tool_input: { command } }, integration);
const enter = (tool_input: { name?: string; path?: string }) =>
  verdict({ tool_name: "EnterWorktree", tool_input });
const reasonOf = (v: ReturnType<typeof verdict>) => (v.decision === "deny" ? v.reason : "");

const ADD = "git worktree add .claude/worktrees/x -b feat/x";

describe("git worktree add", () => {
  it("allows the integration branch, by any of its spellings", () => {
    for (const ref of ["dev", "origin/dev", "refs/heads/dev", "refs/remotes/origin/dev"]) {
      expect(bash(`${ADD} ${ref}`).decision, ref).toBe("allow");
    }
  });

  it("allows the item's claim branch, which pnpm claim pushes on top of origin/dev", () => {
    for (const ref of [
      "origin/f03-012",
      "f03-012",
      "origin/x-000",
      "origin/F03-012",
      "refs/remotes/origin/x-001",
    ]) {
      expect(bash(`${ADD} ${ref}`).decision, ref).toBe("allow");
    }
  });

  it("refuses a branch that only resembles a claim", () => {
    for (const ref of [
      "origin/f03-012-login",
      "origin/f03-12",
      "origin/main",
      "upstream/f03-012",
      "f03-0123",
    ]) {
      expect(bash(`${ADD} ${ref}`).decision, ref).toBe("deny");
    }
  });

  it("refuses another branch, and names it and origin/dev", () => {
    const v = bash(`${ADD} main`);
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("`main`");
    expect(reasonOf(v)).toContain("origin/dev");
  });

  it("refuses no base at all, which is HEAD", () => {
    expect(bash(ADD).decision).toBe("deny");
    expect(bash(`${ADD} 2>&1`).decision).toBe("deny");
  });

  /** The third answer: unreadable refuses rather than guessing either way. */
  it("refuses what it cannot read", () => {
    const v = bash(`${ADD} $BASE`);
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("Could not read");
    expect(
      bash('git -C "$MAIN" worktree add "$MAIN/.claude/worktrees/x" -b f origin/dev').decision,
    ).toBe("deny");
  });

  it("reads a quoted literal rather than refusing it", () => {
    expect(bash('git worktree add ".claude/worktrees/x" -b f "origin/dev"').decision).toBe("allow");
  });

  it("sees git -C <path> worktree add", () => {
    expect(bash("git -C /repo worktree add /repo/.claude/worktrees/x -b f main").decision).toBe(
      "deny",
    );
    expect(
      bash("git -C /repo worktree add /repo/.claude/worktrees/x -b f origin/dev").decision,
    ).toBe("allow");
  });

  it("allows anything carrying a stated reason, which must say something", () => {
    expect(bash(`${ADD} main  # worktree-base: hotfix off production`).decision).toBe("allow");
    expect(bash(`${ADD} main  # worktree-base:`).decision).toBe("deny");
  });

  it("finds the add inside a compound command", () => {
    expect(bash(`cd /tmp && ${ADD} origin/dev`).decision).toBe("allow");
    expect(bash(`cd /tmp && ${ADD} main`).decision).toBe("deny");
  });

  it("ignores commands that create no worktree", () => {
    for (const c of [
      "git worktree list",
      "git worktree remove x",
      "git status",
      "echo git worktree add",
    ]) {
      expect(bash(c).decision, c).toBe("allow");
    }
  });

  it("follows a configured integration branch", () => {
    expect(bash(`${ADD} origin/trunk`, "trunk").decision).toBe("allow");
    expect(bash(`${ADD} origin/dev`, "trunk").decision).toBe("deny");
    expect(reasonOf(bash(`${ADD} main`, "trunk"))).toContain("origin/trunk");
  });
});

describe("EnterWorktree", () => {
  it("refuses to create by name, and says what to type instead", () => {
    for (const args of [{ name: "coverage" }, {}]) {
      const v = enter(args);
      expect(v.decision).toBe("deny");
      expect(reasonOf(v)).toContain("git worktree add");
    }
  });

  it("allows entering one that already exists, by path", () => {
    expect(enter({ path: ".claude/worktrees/coverage" }).decision).toBe("allow");
  });
});

it("has no opinion about any other tool", () => {
  expect(verdict({ tool_name: "Read", tool_input: {} }).decision).toBe("allow");
  expect(verdict({}).decision).toBe("allow");
});

describe("the integration branch, from sdlc.config.json", () => {
  it("is read from the checkout's config", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-base-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(
      join(root, "sdlc.config.json"),
      exampleConfigJson((c) => (c.branches.integration = "trunk")),
    );
    expect(await integrationBranch(root)).toBe("trunk");
  });

  it("could not ask (no config, or an invalid one): the default", async () => {
    const bare = mkdtempSync(join(tmpdir(), "sdlc-base-none-"));
    expect(await integrationBranch(bare)).toBe("dev");
    const broken = mkdtempSync(join(tmpdir(), "sdlc-base-broken-"));
    writeFileSync(join(broken, "sdlc.config.json"), '{ "branches": { "integration": 7 } }');
    expect(await integrationBranch(broken)).toBe("dev");
  });
});

describe("as a hook", () => {
  const script = join(import.meta.dirname, "worktree-base.mts");
  const run = (input: object) =>
    execFileSync("node", [script], { input: JSON.stringify(input), encoding: "utf8" });

  it("prints a deny for a base off main, and nothing for origin/dev", () => {
    const out = run({ tool_name: "Bash", tool_input: { command: `${ADD} main` } });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(run({ tool_name: "Bash", tool_input: { command: `${ADD} origin/dev` } })).toBe("");
  });
});
