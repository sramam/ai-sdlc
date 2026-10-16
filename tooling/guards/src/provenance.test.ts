import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { trailersFor, withTrailers, worktreeOf } from "./provenance.mts";

const T = ["Worktree: wt", "Session: s1"];

describe("which worktree", () => {
  it("reads the root and name from anywhere inside it", () => {
    expect(worktreeOf("/r/.claude/worktrees/wt")).toEqual({
      root: "/r/.claude/worktrees/wt",
      name: "wt",
    });
    expect(worktreeOf("/r/.claude/worktrees/wt/apps/web")).toEqual({
      root: "/r/.claude/worktrees/wt",
      name: "wt",
    });
  });

  it("is null in the main checkout", () => {
    expect(worktreeOf("/r")).toBeNull();
  });
});

describe("appending trailers", () => {
  it("starts a trailer block after a blank line", () => {
    expect(withTrailers("feat: x\n\nWhy it matters.\n", T)).toBe(
      "feat: x\n\nWhy it matters.\n\nWorktree: wt\nSession: s1\n",
    );
  });

  it("joins an existing trailer block rather than starting a second", () => {
    expect(withTrailers("feat: x\n\nProgress: F01 covered\nCo-Authored-By: C <c@x>\n", T)).toBe(
      "feat: x\n\nProgress: F01 covered\nCo-Authored-By: C <c@x>\nWorktree: wt\nSession: s1\n",
    );
  });

  it("does not read a one-line subject as a trailer block", () => {
    expect(withTrailers("fix: something\n", T)).toBe(
      "fix: something\n\nWorktree: wt\nSession: s1\n",
    );
  });

  /** --amend and rebase re-run the hook over a message that already has them. */
  it("is idempotent", () => {
    const once = withTrailers("feat: x\n", T);
    expect(withTrailers(once, T)).toBe(once);
  });

  it("adds only what is missing", () => {
    expect(withTrailers("feat: x\n\nWorktree: wt\n", T)).toBe(
      "feat: x\n\nWorktree: wt\nSession: s1\n",
    );
  });

  it("keeps git's comment lines below the trailers", () => {
    expect(
      withTrailers("feat: x\n\n# Please enter the commit message\n# Lines starting with '#'\n", T),
    ).toBe(
      "feat: x\n\nWorktree: wt\nSession: s1\n\n# Please enter the commit message\n# Lines starting with '#'\n",
    );
  });

  it("leaves a blank first line for the subject in editor mode", () => {
    expect(withTrailers("\n# Please enter the commit message\n", T)).toBe(
      "\n\nWorktree: wt\nSession: s1\n\n# Please enter the commit message\n",
    );
  });
});

describe("what a commit in a directory gets", () => {
  const root = mkdtempSync(join(tmpdir(), "sdlc-prov-"));
  const tree = join(root, ".claude", "worktrees", "wt");
  mkdirSync(join(tree, "src"), { recursive: true });

  it("Worktree alone without a session stamp", () => {
    expect(trailersFor(join(tree, "src"))).toEqual(["Worktree: wt"]);
  });

  it("Worktree and Session with one, and nothing for unknown", () => {
    writeFileSync(join(tree, ".agent-session"), "abc-123\n");
    expect(trailersFor(tree)).toEqual(["Worktree: wt", "Session: abc-123"]);
    writeFileSync(join(tree, ".agent-session"), "unknown\n");
    expect(trailersFor(tree)).toEqual(["Worktree: wt"]);
  });

  it("nothing in the main checkout", () => {
    expect(trailersFor(root)).toEqual([]);
  });

  it("as the hook: edits the message file in a worktree, leaves it alone elsewhere", () => {
    writeFileSync(join(tree, ".agent-session"), "abc-123\n");
    const script = join(import.meta.dirname, "provenance.mts");
    const msg = join(root, "MSG");
    writeFileSync(msg, "feat: x\n");
    execFileSync("node", [script, msg], { cwd: tree });
    expect(readFileSync(msg, "utf8")).toBe("feat: x\n\nWorktree: wt\nSession: abc-123\n");
    writeFileSync(msg, "feat: y\n");
    execFileSync("node", [script, msg], { cwd: root });
    expect(readFileSync(msg, "utf8")).toBe("feat: y\n");
  });
});
