import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY, type RegistryEvent } from "./worktree-registry.mts";
import { openWorktrees, targetOf, verdict } from "./worktree-single.mts";

const add = (path: string, tail = "-b feat/x origin/dev") =>
  ({ tool_name: "Bash", tool_input: { command: `git worktree add ${path} ${tail}` } }) as const;
const enter = (path: string) => ({ tool_name: "EnterWorktree", tool_input: { path } }) as const;
const OPEN = { open: ["alpha"] };
const reasonOf = (v: ReturnType<typeof verdict>) => (v.decision === "deny" ? v.reason : "");

describe("what a call would open", () => {
  it("reads git worktree add, including behind -C", () => {
    expect(targetOf(add(".claude/worktrees/beta"))).toBe("beta");
    expect(
      targetOf({
        tool_name: "Bash",
        tool_input: { command: "git -C /r worktree add /r/.claude/worktrees/c dev" },
      }),
    ).toBe("c");
  });

  it("reads EnterWorktree by path or by name", () => {
    expect(targetOf(enter(".claude/worktrees/beta"))).toBe("beta");
    expect(targetOf({ tool_name: "EnterWorktree", tool_input: { name: "beta" } })).toBe("beta");
  });

  it("says nothing about calls that open no worktree, or one outside .claude/worktrees", () => {
    for (const command of ["git worktree list", "git worktree remove x", "git status", "ls"]) {
      expect(targetOf({ tool_name: "Bash", tool_input: { command } })).toBeNull();
    }
    expect(targetOf(add("/tmp/scratch"))).toBeNull();
  });
});

describe("what is not a second worktree", () => {
  it("allows the first", () => {
    expect(verdict(add(".claude/worktrees/alpha"), { open: [] }).decision).toBe("allow");
  });

  it("allows entering another agent's tree when it has none (/pickup)", () => {
    expect(verdict(enter(".claude/worktrees/theirs"), { open: [] }).decision).toBe("allow");
  });

  it("allows re-entering its own", () => {
    expect(verdict(enter(".claude/worktrees/alpha"), OPEN).decision).toBe("allow");
  });

  it("ignores calls that open nothing", () => {
    expect(
      verdict({ tool_name: "Bash", tool_input: { command: "git status" } }, OPEN).decision,
    ).toBe("allow");
  });
});

describe("a second one", () => {
  it("refuses, naming both and printing the way out", () => {
    const v = verdict(add(".claude/worktrees/beta"), OPEN);
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("beta");
    expect(reasonOf(v)).toContain("git worktree remove .claude/worktrees/alpha");
    expect(reasonOf(v)).toContain("pnpm worktrees --close alpha");
  });

  it("refuses switching to another agent's tree", () => {
    expect(verdict(enter(".claude/worktrees/theirs"), OPEN).decision).toBe("deny");
  });

  it("allows a stated reason that says something; EnterWorktree has none to give", () => {
    const ok = verdict(
      add(".claude/worktrees/beta", "-b f origin/dev  # worktree-single: two recordings"),
      OPEN,
    );
    expect(ok).toEqual({ decision: "allow", note: "stated reason: two recordings" });
    expect(
      verdict(add(".claude/worktrees/beta", "-b f origin/dev  # worktree-single:"), OPEN).decision,
    ).toBe("deny");
    expect(verdict(enter(".claude/worktrees/beta"), OPEN).decision).toBe("deny");
  });
});

describe("which worktrees are this session's", () => {
  const at = "2026-10-15T00:00:00.000Z";
  const registry = (events: RegistryEvent[]): string => {
    const root = mkdtempSync(join(tmpdir(), "wt-single-"));
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, REGISTRY), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return root;
  };
  const event = (o: Partial<RegistryEvent>): RegistryEvent => ({
    at,
    kind: "created",
    worktree: "alpha",
    sessionId: "mine",
    ...o,
  });

  it("counts what it created and what it entered", () => {
    const root = registry([
      event({ worktree: "alpha" }),
      event({ worktree: "beta", kind: "entered" }),
    ]);
    expect(openWorktrees(root, "mine", ["alpha", "beta"])).toEqual(["alpha", "beta"]);
  });

  it("does not count another session's", () => {
    const root = registry([event({}), event({ worktree: "theirs", sessionId: "other" })]);
    expect(openWorktrees(root, "mine", ["alpha", "theirs"])).toEqual(["alpha"]);
  });

  /** Live, not ever: a closed tree does not hold the session back. */
  it("drops one that is gone from disk", () => {
    expect(openWorktrees(registry([event({ worktree: "closed" })]), "mine", [])).toEqual([]);
  });

  it("counts nothing for a session with no id, or no registry", () => {
    expect(openWorktrees(registry([event({ sessionId: "unknown" })]), "", ["alpha"])).toEqual([]);
    expect(
      openWorktrees(mkdtempSync(join(tmpdir(), "wt-single-none-")), "mine", ["alpha"]),
    ).toEqual([]);
  });
});
