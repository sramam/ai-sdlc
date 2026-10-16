import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRegistry } from "./worktree-registry.mts";
import { SESSION_FILE, run } from "./worktree-trace.mts";

const NOW = new Date("2026-10-15T10:00:00.000Z");

/** A main checkout with one worktree directory, standing in for a real one. */
function fixture(): { root: string; tree: string } {
  const root = mkdtempSync(join(tmpdir(), "sdlc-trace-"));
  const tree = join(root, ".claude", "worktrees", "wt");
  mkdirSync(tree, { recursive: true });
  return { root, tree };
}

const stdin = (o: object) => JSON.stringify(o);

describe("recording", () => {
  it("records a creation and stamps the session into the tree", () => {
    const { root, tree } = fixture();
    run(
      stdin({
        session_id: "s1",
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: "git worktree add .claude/worktrees/wt -b f origin/dev" },
      }),
      root,
      root,
      NOW,
    );
    expect(readRegistry(root)).toEqual([
      {
        at: NOW.toISOString(),
        kind: "created",
        worktree: "wt",
        sessionId: "s1",
        branch: "f",
        base: "origin/dev",
      },
    ]);
    expect(readFileSync(join(tree, SESSION_FILE), "utf8")).toBe("s1\n");
  });

  it("records an entry and re-stamps for the entering session", () => {
    const { root, tree } = fixture();
    run(
      stdin({
        session_id: "s2",
        cwd: root,
        tool_name: "EnterWorktree",
        tool_input: { path: ".claude/worktrees/wt" },
      }),
      root,
      root,
      NOW,
    );
    expect(readRegistry(root).map((e) => e.kind)).toEqual(["entered"]);
    expect(readFileSync(join(tree, SESSION_FILE), "utf8")).toBe("s2\n");
  });

  it("does not stamp an unknown session", () => {
    const { root, tree } = fixture();
    run(
      stdin({
        cwd: root,
        tool_name: "EnterWorktree",
        tool_input: { path: ".claude/worktrees/wt" },
      }),
      root,
      root,
      NOW,
    );
    expect(existsSync(join(tree, SESSION_FILE))).toBe(false);
    expect(readRegistry(root)[0]?.sessionId).toBe("unknown");
  });
});

describe("claiming an unrecorded worktree", () => {
  it("claims it as entered, never created, and only once", () => {
    const { root, tree } = fixture();
    const edit = stdin({
      session_id: "s3",
      cwd: tree,
      tool_name: "Edit",
      tool_input: { file_path: join(tree, "a.ts") },
    });
    run(edit, root, tree, NOW);
    run(edit, root, tree, NOW);
    expect(readRegistry(root)).toEqual([
      { at: NOW.toISOString(), kind: "entered", worktree: "wt", sessionId: "s3" },
    ]);
    expect(readFileSync(join(tree, SESSION_FILE), "utf8")).toBe("s3\n");
  });

  it("does not claim one already recorded", () => {
    const { root, tree } = fixture();
    run(
      stdin({
        session_id: "s1",
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: "git worktree add .claude/worktrees/wt -b f dev" },
      }),
      root,
      root,
      NOW,
    );
    run(
      stdin({ session_id: "s4", cwd: tree, tool_name: "Bash", tool_input: { command: "ls" } }),
      root,
      tree,
      NOW,
    );
    expect(readRegistry(root).map((e) => `${e.kind}:${e.sessionId}`)).toEqual(["created:s1"]);
  });

  it("uses the payload's cwd, not the process's", () => {
    const { root } = fixture();
    run(
      stdin({ session_id: "s5", cwd: root, tool_name: "Bash", tool_input: { command: "ls" } }),
      root,
      "/x/.claude/worktrees/elsewhere",
      NOW,
    );
    expect(readRegistry(root)).toEqual([]);
  });
});

describe("never failing the tool call", () => {
  it("swallows garbage input and an unwritable registry", () => {
    expect(() => run("not json", "/nonexistent-root", "/", NOW)).not.toThrow();
    expect(() =>
      run(
        stdin({
          session_id: "s",
          tool_name: "Bash",
          tool_input: { command: "git worktree add .claude/worktrees/x dev" },
        }),
        "/dev/null/nope",
        "/",
        NOW,
      ),
    ).not.toThrow();
  });

  it("exits 0 as a hook, even outside a repository", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "sdlc-trace-norepo-")));
    const script = join(import.meta.dirname, "worktree-trace.mts");
    expect(() =>
      execFileSync("node", [script], { cwd: outside, input: "{}", encoding: "utf8" }),
    ).not.toThrow();
    expect(() =>
      execFileSync("node", [script], { cwd: outside, input: "garbage", encoding: "utf8" }),
    ).not.toThrow();
  });
});
