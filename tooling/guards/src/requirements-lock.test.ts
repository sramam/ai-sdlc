import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SESSION_FILE,
  markedSkill,
  requirementsDir,
  verdict,
  type Facts,
} from "./requirements-lock.mts";

const ROOT = "/repo";
const facts = (marks: string[] = [], requirementsDir = "docs/requirements"): Facts => ({
  root: ROOT,
  requirementsDir,
  marks,
});
const write = (file_path: string, f: Facts, session_id = "s1", tool_name = "Write") =>
  verdict({ session_id, cwd: ROOT, tool_name, tool_input: { file_path } }, f);
const reasonOf = (v: ReturnType<typeof verdict>) => (v.decision === "deny" ? v.reason : "");

describe("outside the requirements", () => {
  it("allows everything else, including near-miss names", () => {
    for (const p of [
      "src/a.ts",
      "docs/plan/x.md",
      "docs/requirements.md",
      "docs/requirements-old/x.md",
      "/elsewhere/docs/requirements/x.md",
    ]) {
      expect(write(p, facts()).decision, p).toBe("allow");
    }
  });

  it("ignores tools that name no file, and non-write tools", () => {
    expect(verdict({ tool_name: "Bash", tool_input: {} }, facts()).decision).toBe("allow");
    expect(verdict({ tool_name: "Write", tool_input: {} }, facts()).decision).toBe("allow");
  });
});

describe("inside the requirements", () => {
  it("refuses an unmarked session, naming the skills", () => {
    const v = write(`${ROOT}/docs/requirements/brd.md`, facts());
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("/add-requirement");
    expect(reasonOf(v)).toContain(SESSION_FILE);
  });

  it("covers every named-write tool, and notebook_path", () => {
    for (const tool of ["Edit", "MultiEdit", "Write"]) {
      expect(write("docs/requirements/a.md", facts(), "s1", tool).decision, tool).toBe("deny");
    }
    const nb = verdict(
      {
        tool_name: "NotebookEdit",
        cwd: ROOT,
        tool_input: { notebook_path: "docs/requirements/a.ipynb" },
      },
      facts(),
    );
    expect(nb.decision).toBe("deny");
  });

  it("allows a session marked with one of the three skills", () => {
    for (const skill of ["kickoff", "idea", "add-requirement"]) {
      expect(write("docs/requirements/a.md", facts([`s1 ${skill}`]))).toEqual({
        decision: "allow",
        note: `requirements session: ${skill}`,
      });
    }
  });

  it("refuses another session's mark, and says the file names others", () => {
    const v = write("docs/requirements/a.md", facts(["s2 kickoff"]));
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("names other sessions");
  });

  it("refuses an unknown skill", () => {
    expect(write("docs/requirements/a.md", facts(["s1 refactor"])).decision).toBe("deny");
  });

  it("never matches an empty session id", () => {
    expect(markedSkill([" kickoff", "kickoff"], "")).toBeNull();
    expect(write("docs/requirements/a.md", facts([" kickoff"]), "").decision).toBe("deny");
  });

  it("refuses every write under sources/, even for a marked session", () => {
    const v = write("docs/requirements/sources/brd.pdf", facts(["s1 kickoff"]));
    expect(v.decision).toBe("deny");
    expect(reasonOf(v)).toContain("sources/");
  });

  it("follows a configured directory", () => {
    expect(write("spec/a.md", facts([], "spec")).decision).toBe("deny");
    expect(write("docs/requirements/a.md", facts([], "spec")).decision).toBe("allow");
  });
});

describe("the directory, from sdlc.config.ts", () => {
  it("reads dirs.requirements, defaulting when absent or broken", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-req-cfg-"));
    expect(await requirementsDir(root)).toBe("docs/requirements");
    writeFileSync(
      join(root, "sdlc.config.ts"),
      'export default { dirs: { requirements: "spec" } };\n',
    );
    expect(await requirementsDir(root)).toBe("spec");
    // A fresh directory: a module URL is imported once per process.
    const broken = mkdtempSync(join(tmpdir(), "sdlc-req-broken-"));
    writeFileSync(join(broken, "sdlc.config.ts"), 'throw new Error("x");\n');
    expect(await requirementsDir(broken)).toBe("docs/requirements");
  });
});

/** End to end, against a main checkout and a linked worktree with its own marks file. */
describe("as a hook", () => {
  const script = join(import.meta.dirname, "requirements-lock.mts");
  const main = realpathSync(mkdtempSync(join(tmpdir(), "sdlc-req-")));
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: main,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  g("init", "-q", "-b", "dev");
  g("update-ref", "refs/heads/dev", g("commit-tree", g("write-tree"), "-m", "init"));
  const tree = join(main, ".claude", "worktrees", "req");
  g("worktree", "add", "-q", tree, "-b", "req/x", "dev");

  const run = (session_id: string, file_path: string) =>
    execFileSync("node", [script], {
      cwd: main,
      input: JSON.stringify({
        session_id,
        cwd: main,
        tool_name: "Write",
        tool_input: { file_path },
      }),
      encoding: "utf8",
    });

  it("denies an unmarked write, allows a marked one — marks read from the target's checkout", () => {
    const target = join(tree, "docs", "requirements", "brd.md");
    expect(JSON.parse(run("s1", target)).hookSpecificOutput.permissionDecision).toBe("deny");

    // A mark in the main checkout does not cover a write landing in the worktree.
    mkdirSync(join(main, ".claude"), { recursive: true });
    writeFileSync(join(main, SESSION_FILE), "s1 kickoff\n");
    expect(JSON.parse(run("s1", target)).hookSpecificOutput.permissionDecision).toBe("deny");

    mkdirSync(join(tree, ".claude"), { recursive: true });
    writeFileSync(join(tree, SESSION_FILE), "s1 kickoff\n");
    expect(run("s1", target)).toBe("");
    expect(
      JSON.parse(run("s1", join(tree, "docs/requirements/sources/a.md"))).hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
  });

  it("could not ask (not a repository): allows", () => {
    const outside = mkdtempSync(join(tmpdir(), "sdlc-req-norepo-"));
    expect(run("s1", join(outside, "docs/requirements/a.md"))).toBe("");
  });
});
