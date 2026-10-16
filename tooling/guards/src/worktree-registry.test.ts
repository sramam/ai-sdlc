import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REGISTRY,
  append,
  drift,
  eventFor,
  isRecorded,
  parsePorcelain,
  pruneClosed,
  readRegistry,
  summarise,
  worktreeNameFrom,
  type RegistryEvent,
} from "./worktree-registry.mts";

const NOW = new Date("2026-10-15T10:00:00.000Z");
const at = NOW.toISOString();

describe("a worktree name out of a path", () => {
  it("takes the directory name, not the whole path", () => {
    expect(worktreeNameFrom(".claude/worktrees/five")).toBe("five");
    expect(worktreeNameFrom("/Users/x/repo/.claude/worktrees/j40/apps/web")).toBe("j40");
  });

  it("stops at a quote, so a quoted command path yields a usable name", () => {
    expect(worktreeNameFrom('"$MAIN/.claude/worktrees/audit"')).toBe("audit");
  });

  it("is null anywhere else", () => {
    expect(worktreeNameFrom("/Users/x/repo")).toBeNull();
    expect(worktreeNameFrom(undefined)).toBeNull();
  });
});

describe("what a tool call records", () => {
  it("records a creation with the session, branch and base", () => {
    expect(
      eventFor(
        {
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "git worktree add .claude/worktrees/five -b feat/x origin/dev" },
        },
        NOW,
      ),
    ).toEqual({
      at,
      kind: "created",
      worktree: "five",
      sessionId: "s1",
      branch: "feat/x",
      base: "origin/dev",
    });
  });

  it("sees a creation behind git -C, and leaves unreadable labels blank", () => {
    const event = eventFor(
      {
        session_id: "s1",
        tool_name: "Bash",
        tool_input: {
          command: 'git -C "$M" worktree add "$M/.claude/worktrees/a" -b f origin/dev',
        },
      },
      NOW,
    );
    expect(event).toEqual({ at, kind: "created", worktree: "a", sessionId: "s1" });
  });

  it("takes the name from the add, not from an earlier cd into another worktree", () => {
    const event = eventFor(
      {
        tool_name: "Bash",
        tool_input: { command: "cd .claude/worktrees/old && git worktree add ../new-one dev" },
      },
      NOW,
    );
    expect(event).toBeNull(); // ../new-one is not under .claude/worktrees/ by its text
  });

  it("records nothing for a creation git refused", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git worktree add .claude/worktrees/x -b f dev" },
      tool_response: { stdout: "", stderr: "fatal: a branch named 'f' already exists" },
    };
    expect(eventFor(input, NOW)).toBeNull();
  });

  it("records an entry by path or by name", () => {
    expect(
      eventFor(
        {
          session_id: "s2",
          tool_name: "EnterWorktree",
          tool_input: { path: ".claude/worktrees/j40" },
        },
        NOW,
      ),
    ).toEqual({
      at,
      kind: "entered",
      worktree: "j40",
      sessionId: "s2",
    });
    expect(
      eventFor({ tool_name: "EnterWorktree", tool_input: { name: "j41" } }, NOW),
    ).toMatchObject({ worktree: "j41" });
  });

  it("names an absent session rather than inventing one", () => {
    expect(
      eventFor(
        { tool_name: "Bash", tool_input: { command: "git worktree add .claude/worktrees/x dev" } },
        NOW,
      ),
    ).toMatchObject({
      sessionId: "unknown",
    });
  });

  it("records nothing for an ordinary command or tool", () => {
    expect(eventFor({ tool_name: "Bash", tool_input: { command: "pnpm test" } }, NOW)).toBeNull();
    expect(eventFor({ tool_name: "Read", tool_input: {} }, NOW)).toBeNull();
  });
});

describe("the file", () => {
  it("appends and reads back, skipping a truncated line", () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-registry-"));
    append(root, { at, kind: "created", worktree: "a", sessionId: "s1" });
    writeFileSync(join(root, REGISTRY), '{"at":"x","kind":"crea', { flag: "a" });
    expect(readRegistry(root)).toEqual([{ at, kind: "created", worktree: "a", sessionId: "s1" }]);
  });

  it("is empty when absent", () => {
    expect(readRegistry(mkdtempSync(join(tmpdir(), "sdlc-registry-none-")))).toEqual([]);
  });

  it("knows whether a worktree was ever claimed", () => {
    const events: RegistryEvent[] = [{ at, kind: "entered", worktree: "a", sessionId: "s" }];
    expect(isRecorded(events, "a")).toBe(true);
    expect(isRecorded(events, "b")).toBe(false);
  });
});

describe("one row per worktree", () => {
  const events: RegistryEvent[] = [
    { at, kind: "created", worktree: "a", sessionId: "s1", branch: "feat/a", base: "origin/dev" },
    { at, kind: "entered", worktree: "a", sessionId: "s1" },
    { at, kind: "entered", worktree: "a", sessionId: "s2" },
    { at, kind: "entered", worktree: "a", sessionId: "s2" },
  ];

  it("keeps who made it apart from who entered it", () => {
    expect(summarise(events)[0]).toMatchObject({
      worktree: "a",
      createdBy: "s1",
      enteredBy: ["s2"],
      branch: "feat/a",
    });
  });

  it("records a worktree only ever entered as created by unknown", () => {
    const [row] = summarise([{ at, kind: "entered", worktree: "old", sessionId: "s9" }]);
    expect(row).toMatchObject({ createdBy: "unknown", enteredBy: ["s9"] });
  });
});

describe("the registry against reality", () => {
  const records = summarise([
    { at, kind: "created", worktree: "live", sessionId: "s1" },
    { at, kind: "created", worktree: "gone", sessionId: "s2" },
  ]);

  it("reports both directions", () => {
    const d = drift(records, ["live", "surprise"]);
    expect(d.orphaned.map((r) => r.worktree)).toEqual(["gone"]);
    expect(d.unrecorded).toEqual(["surprise"]);
  });

  it("prunes one worktree and touches no other", () => {
    const events: RegistryEvent[] = [
      { at, kind: "created", worktree: "done", sessionId: "s1" },
      { at, kind: "created", worktree: "other", sessionId: "s2" },
    ];
    expect(pruneClosed(events, "done")).toEqual([events[1]]);
  });
});

describe("git worktree list --porcelain", () => {
  it("keeps .claude/worktrees/* with their live branch, detached ones without", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/dev",
      "",
      "worktree /repo/.claude/worktrees/b",
      "HEAD def",
      "branch refs/heads/feat/b",
      "",
      "worktree /repo/.claude/worktrees/a",
      "HEAD 123",
      "detached",
      "",
    ].join("\n");
    expect(parsePorcelain(porcelain)).toEqual([{ name: "a" }, { name: "b", branch: "feat/b" }]);
  });

  it("is empty with no linked worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-porcelain-"));
    mkdirSync(join(root, "x"));
    expect(parsePorcelain("worktree /repo\nHEAD a\nbranch refs/heads/dev\n")).toEqual([]);
  });
});
