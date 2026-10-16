import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXEMPT_FILE,
  SESSION_VAR,
  autoName,
  readExemption,
  verdict,
  type Facts,
  type HookInput,
} from "./worktree-required.mts";

const ROOT = "/repo";
const SESSION = "sess-a";
const facts = (exemption: Facts["exemption"] = null): Facts => ({ mainCheckout: ROOT, exemption });

const editWith = (file_path: string, f: Facts, input: Partial<HookInput> = {}) =>
  verdict(
    { tool_name: "Edit", session_id: SESSION, cwd: ROOT, tool_input: { file_path }, ...input },
    f,
  );
const edit = (file_path: string) => editWith(file_path, facts());
const bash = (command: string, cwd = ROOT, f: Facts = facts()) =>
  verdict({ tool_name: "Bash", session_id: SESSION, cwd, tool_input: { command } }, f);
const reasonOf = (v: ReturnType<typeof verdict>) => (v.decision === "deny" ? v.reason : "");

describe("a named write", () => {
  it("refuses one landing in the main checkout, naming origin/dev", () => {
    const v = edit(`${ROOT}/src/page.ts`);
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("main checkout");
    expect(reasonOf(v)).toContain("origin/dev");
  });

  it("covers every named-write tool", () => {
    for (const tool_name of ["Write", "NotebookEdit", "MultiEdit"]) {
      const v = verdict(
        {
          tool_name,
          session_id: SESSION,
          cwd: ROOT,
          tool_input: { file_path: `${ROOT}/x.ts`, notebook_path: `${ROOT}/x.ipynb` },
        },
        facts(),
      );
      expect(v.decision, tool_name).toBe("deny");
    }
  });

  it("allows one inside a worktree", () => {
    expect(edit(`${ROOT}/.claude/worktrees/x/src/page.ts`).decision).toBe("allow");
  });

  it("allows a handoff, which belongs in the main checkout", () => {
    expect(edit(`${ROOT}/docs/handoffs/2026-10-15-feat-x.md`).decision).toBe("allow");
  });

  it("reads the exempt paths from facts when the config names another", () => {
    const f = { ...facts(), exemptPaths: ["notes/handoffs/"] };
    expect(editWith(`${ROOT}/notes/handoffs/a.md`, f).decision).toBe("allow");
    expect(editWith(`${ROOT}/docs/handoffs/a.md`, f).decision).toBe("deny");
  });

  it("allows anything outside the repository", () => {
    expect(edit("/tmp/scratch/notes.md").decision).toBe("allow");
  });

  it("compares paths by segment, not by prefix", () => {
    expect(edit("/repo-backup/page.ts").decision).toBe("allow");
    expect(edit(`${ROOT}/.claude/worktrees-old/x.ts`).decision).toBe("deny");
  });

  it("resolves a relative path against the session's directory", () => {
    expect(
      verdict(
        {
          tool_name: "Edit",
          session_id: SESSION,
          cwd: `${ROOT}/.claude/worktrees/x`,
          tool_input: { file_path: "src/a.ts" },
        },
        facts(),
      ).decision,
    ).toBe("allow");
  });

  it("names the configured integration branch", () => {
    expect(
      reasonOf(
        verdict(
          { tool_name: "Edit", cwd: ROOT, tool_input: { file_path: "a" } },
          { ...facts(), integration: "trunk" },
        ),
      ),
    ).toContain("origin/trunk");
  });
});

describe("git commit", () => {
  it("refuses one made in the main checkout", () => {
    expect(bash('git commit -m "x"').decision).toBe("deny");
  });

  it("allows one made in a worktree", () => {
    expect(bash('git commit -m "x"', `${ROOT}/.claude/worktrees/x`).decision).toBe("allow");
  });

  it("allows one carrying a stated reason, and says so", () => {
    const v = bash('git commit -m "x"  # worktree: recording, one warm checkout');
    expect(v).toEqual({ decision: "allow", note: "stated reason: recording, one warm checkout" });
  });

  it("requires the reason to say something", () => {
    expect(bash('git commit -m "x"  # worktree:').decision).toBe("deny");
  });

  it("follows -C out of a worktree and refuses it", () => {
    const wt = `${ROOT}/.claude/worktrees/x`;
    expect(bash(`git -C ${ROOT} commit -m x`, wt).decision).toBe("deny");
    expect(bash(`git --work-tree ${ROOT} commit -m x`, wt).decision).toBe("deny");
  });

  it("follows -C into a worktree and allows it", () => {
    expect(bash(`git -C ${ROOT}/.claude/worktrees/x commit -m x`).decision).toBe("allow");
  });

  it("refuses a destination it cannot read, and says which part", () => {
    const v = bash('git -C "$MAIN" commit -m x', `${ROOT}/.claude/worktrees/x`);
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("shell variable");
    expect(bash('git -C "$MAIN" commit -m x  # worktree: landing a fix').decision).toBe("allow");
  });

  it("sees a commit behind global flags, valued or not", () => {
    for (const c of [
      "git -C . commit -m x",
      "git -c user.name=x commit -m x",
      "git --no-pager commit -m x",
      "cd src && git commit -m x",
    ]) {
      expect(bash(c).decision, c).toBe("deny");
    }
  });

  /** The honest gap, pinned so nobody reads its absence as coverage. */
  it("does not gate other Bash, including writes it cannot see", () => {
    for (const c of ["sed -i '' s/a/b/ x.ts", "pnpm build", "git status", "git add x", "git log"]) {
      expect(bash(c).decision, c).toBe("allow");
    }
  });
});

describe("the session-keyed exemption", () => {
  const claim = { sessionId: SESSION, reason: "recording journeys" };

  it("allows this session, and says why", () => {
    expect(editWith(`${ROOT}/e2e/a.ts`, facts(claim))).toEqual({
      decision: "allow",
      note: "exempt: recording journeys",
    });
  });

  it("refuses another session, and names whose claim it found", () => {
    const v = editWith(`${ROOT}/e2e/a.ts`, facts(claim), { session_id: "sess-b" });
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("sess-a");
    expect(reasonOf(v)).toContain("deleted rather than reused");
  });

  it("an empty id exempts nobody, even a hook with no session id", () => {
    const empty = facts({ sessionId: "", reason: "recording" });
    expect(editWith(`${ROOT}/a.ts`, empty).decision).toBe("deny");
    const v = editWith(`${ROOT}/a.ts`, empty, { session_id: "" });
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain(SESSION_VAR);
    expect(reasonOf(v)).toContain("no session id");
  });

  it("a hook with no session id is not matched by any claim", () => {
    expect(editWith(`${ROOT}/a.ts`, facts(claim), { session_id: "" }).decision).toBe("deny");
  });
});

describe("the refusal", () => {
  it("offers a stable, per-session fallback name and asks for one", () => {
    expect(autoName("a")).toBe(autoName("a"));
    expect(autoName("a")).not.toBe(autoName("b"));
    expect(autoName("")).toMatch(/^wt-[0-9a-f]{6}$/);
    const reason = reasonOf(edit(`${ROOT}/a.ts`));
    expect(reason).toContain(autoName(SESSION));
    expect(reason).toContain("Ask the user what to call the worktree");
  });

  it("teaches CLAUDE_CODE_SESSION_ID, never the unset CLAUDE_SESSION_ID", () => {
    const reason = reasonOf(edit(`${ROOT}/a.ts`));
    expect(reason).toContain(`$${SESSION_VAR}`);
    expect(reason).not.toMatch(/\$CLAUDE_SESSION_ID\b/);
  });
});

describe("reading the marker", () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-exempt-"));
  const write = (body: string) => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, EXEMPT_FILE), body);
  };

  it("is null when there is no file", () => {
    expect(readExemption(join(root, "nowhere"))).toBeNull();
  });

  it("reads a session and a reason, from the first line only, tolerating CRLF", () => {
    write("sess-a  recording\r\njunk\n");
    expect(readExemption(root)).toEqual({ sessionId: "sess-a", reason: "recording" });
  });

  it("reads a leading-space line as an empty id, not the reason's first word", () => {
    write("  writing the handoff\n");
    expect(readExemption(root)).toEqual({ sessionId: "", reason: "writing the handoff" });
  });

  it("refuses a one-word line and a blank one", () => {
    write("recording\n");
    expect(readExemption(root)).toBeNull();
    write("   \n");
    expect(readExemption(root)).toBeNull();
  });
});

/** The entry point, end to end against a real repository: proof by tripping. */
describe("as a hook", () => {
  const script = join(import.meta.dirname, "worktree-required.mts");
  const main = realpathSync(mkdtempSync(join(tmpdir(), "sdlc-required-")));
  execFileSync("git", ["init", "-q", "-b", "dev"], { cwd: main });
  mkdirSync(join(main, ".claude", "worktrees", "wt"), { recursive: true });

  const run = (input: HookInput, cwd = main) =>
    execFileSync("node", [script], { cwd, input: JSON.stringify(input), encoding: "utf8" });

  it("denies a write in the main checkout with the hook's JSON", () => {
    const out = run({
      session_id: "s1",
      cwd: main,
      tool_name: "Write",
      tool_input: { file_path: join(main, "a.ts") },
    });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows a write in a worktree directory, and a handoff", () => {
    expect(
      run({
        session_id: "s1",
        cwd: main,
        tool_name: "Write",
        tool_input: { file_path: join(main, ".claude/worktrees/wt/a.ts") },
      }),
    ).toBe("");
    expect(
      run({
        session_id: "s1",
        cwd: main,
        tool_name: "Write",
        tool_input: { file_path: join(main, "docs/handoffs/h.md") },
      }),
    ).toBe("");
  });

  it("allows through a session's own exemption", () => {
    writeFileSync(join(main, EXEMPT_FILE), "s2  recording\n");
    expect(
      run({
        session_id: "s2",
        cwd: main,
        tool_name: "Write",
        tool_input: { file_path: join(main, "a.ts") },
      }),
    ).toBe("");
  });

  it("could not ask (not a repository): allows", () => {
    const outside = mkdtempSync(join(tmpdir(), "sdlc-norepo-"));
    expect(
      run(
        {
          session_id: "s1",
          cwd: outside,
          tool_name: "Write",
          tool_input: { file_path: join(outside, "a.ts") },
        },
        outside,
      ),
    ).toBe("");
  });
});
