import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonical,
  checkoutRoot,
  gitSegment,
  gitWorkingDir,
  invokesGit,
  mainCheckout,
  parseWorktreeAdd,
  shellLiteral,
  subcommandArgs,
} from "./git-command.mts";

/** The real command that walked past two of door_nexa's three parsers. */
const VIA_C =
  "MAIN=/Users/me/repo\n" +
  'git -C "$MAIN" worktree add "$MAIN/.claude/worktrees/audit" -b feat/audit origin/dev 2>&1 | tail -5';

describe("a global option between git and its subcommand", () => {
  it("does not hide git -C <path> worktree add", () => {
    expect(gitSegment(VIA_C, "worktree", "add")).not.toBeNull();
  });

  it("steps over every option that takes a value", () => {
    for (const opt of [
      "-C /p",
      "-c user.name=x",
      "--git-dir /a/.git",
      "--work-tree /a",
      "--namespace ns",
    ]) {
      expect(invokesGit(`git ${opt} worktree add x dev`, "worktree", "add")).toBe(true);
      expect(invokesGit(`git ${opt} commit -m x`, "commit")).toBe(true);
    }
  });

  it("does not mistake an option's value for the subcommand", () => {
    expect(invokesGit("git -C commit status", "commit")).toBe(false);
    expect(invokesGit("git -c alias.x=add worktree list", "worktree", "add")).toBe(false);
  });

  it("still reads a bare flag", () => {
    expect(invokesGit("git --no-pager worktree add x dev", "worktree", "add")).toBe(true);
  });
});

describe("the subcommand path is a sequence", () => {
  it("tells worktree add from the rest of worktree", () => {
    expect(invokesGit("git worktree add x dev", "worktree", "add")).toBe(true);
    for (const other of ["list", "remove x", "prune", "move a b"]) {
      expect(invokesGit(`git worktree ${other}`, "worktree", "add")).toBe(false);
    }
  });

  it("is not fooled by the words appearing as arguments", () => {
    expect(invokesGit("git commit -m 'worktree add'", "worktree", "add")).toBe(false);
    expect(invokesGit("grep worktree add file", "worktree", "add")).toBe(false);
  });

  it("reads git only in command position", () => {
    expect(invokesGit("echo git commit -m x", "commit")).toBe(false);
    expect(invokesGit("gh pr create --title 'git worktree add'", "worktree", "add")).toBe(false);
    expect(invokesGit("GIT_EDITOR=true git commit", "commit")).toBe(true);
    expect(invokesGit("env FOO=1 git commit", "commit")).toBe(true);
    expect(invokesGit("(git commit -m x", "commit")).toBe(true);
  });

  it("finds git at an absolute path", () => {
    expect(invokesGit("/usr/bin/git worktree add x dev", "worktree", "add")).toBe(true);
  });

  it("returns the arguments after the subcommand", () => {
    expect(subcommandArgs("git -C . worktree add x dev", "worktree", "add")).toEqual(["x", "dev"]);
  });
});

describe("compound commands", () => {
  it("finds the segment that runs it, across && ; | and newlines", () => {
    expect(gitSegment("cd /tmp && git worktree add x dev", "worktree", "add")?.trim()).toBe(
      "git worktree add x dev",
    );
    expect(gitSegment("echo hi | git commit -F -", "commit")?.trim()).toBe("git commit -F -");
  });

  it("is null when no segment runs it", () => {
    expect(gitSegment("pnpm test && ls", "worktree", "add")).toBeNull();
    expect(gitSegment("", "commit")).toBeNull();
  });
});

describe("shell literals", () => {
  it("strips quotes from a readable path", () => {
    expect(shellLiteral('"/repo"')).toBe("/repo");
    expect(shellLiteral("'/repo'")).toBe("/repo");
    expect(shellLiteral("/repo")).toBe("/repo");
  });

  it("is null for anything the shell decides", () => {
    for (const t of ['"$MAIN"', "$(pwd)", "`pwd`", "~/x", "*.ts"])
      expect(shellLiteral(t)).toBeNull();
  });
});

describe("reading a git worktree add", () => {
  it("takes path, branch and base", () => {
    expect(parseWorktreeAdd("git worktree add .claude/worktrees/x -b feat/x origin/dev")).toEqual({
      path: ".claude/worktrees/x",
      branch: "feat/x",
      base: "origin/dev",
      unreadable: false,
    });
  });

  it("stops at a trailing comment, so an override is not a positional", () => {
    expect(
      parseWorktreeAdd(
        "git worktree add .claude/worktrees/x -b fix/y main  # worktree-base: hotfix",
      ),
    ).toMatchObject({ branch: "fix/y", base: "main" });
  });

  it("reads quoted literals and flags variables as unreadable", () => {
    expect(parseWorktreeAdd('git worktree add ".claude/worktrees/x" dev')).toMatchObject({
      path: ".claude/worktrees/x",
      base: "dev",
      unreadable: false,
    });
    expect(parseWorktreeAdd(VIA_C)).toMatchObject({ unreadable: true, branch: "feat/audit" });
  });

  it("does not take a pipe's command as the base", () => {
    expect(parseWorktreeAdd("git worktree add .claude/worktrees/x | tail")?.base).toBeUndefined();
  });

  it("does not take a redirection as the base", () => {
    for (const tail of ["2>/dev/null", "2>&1", "> log.txt", ">>log"]) {
      expect(
        parseWorktreeAdd(`git worktree add .claude/worktrees/x ${tail}`)?.base,
        tail,
      ).toBeUndefined();
    }
    expect(parseWorktreeAdd("git worktree add .claude/worktrees/x dev 2>&1")?.base).toBe("dev");
  });

  it("is null when the command adds no worktree", () => {
    expect(parseWorktreeAdd("git worktree list")).toBeNull();
  });
});

describe("where git would actually act", () => {
  const at = (segment: string, cwd = "/repo/.claude/worktrees/wt") =>
    gitWorkingDir(segment, cwd, resolve);

  it("is the session's directory when nothing moves it", () => {
    expect(at("git commit -m x")).toBe("/repo/.claude/worktrees/wt");
  });

  /** The dangerous direction: this commits into the main checkout from a worktree. */
  it("follows -C out of the worktree", () => {
    expect(at("git -C /repo commit -m x")).toBe("/repo");
  });

  it("follows a relative -C, and composes several", () => {
    expect(at("git -C ../../.. commit -m x")).toBe("/repo");
    expect(at("git -C /repo -C .claude/worktrees/wt commit -m x")).toBe(
      "/repo/.claude/worktrees/wt",
    );
  });

  it("lets --work-tree override, in either spelling", () => {
    expect(at("git --work-tree /repo commit")).toBe("/repo");
    expect(at("git --work-tree=/repo commit")).toBe("/repo");
    expect(at("git -C /elsewhere --work-tree /repo commit")).toBe("/repo");
  });

  it("reads a quoted path rather than giving up on it", () => {
    expect(at('git -C "/repo" commit -m x')).toBe("/repo");
  });

  it("says it cannot tell when the path is the shell's", () => {
    expect(at('git -C "$MAIN" commit -m x')).toBeNull();
    expect(at("git -C $(pwd) commit -m x")).toBeNull();
    expect(at("git --work-tree=$HOME commit -m x")).toBeNull();
  });

  it("is not confused by options after the subcommand", () => {
    expect(at("git commit -C HEAD --amend")).toBe("/repo/.claude/worktrees/wt");
  });
});

/** A throwaway repository with one commit on `dev` and one linked worktree. */
function repoWithWorktree(): { main: string; worktree: string } {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "sdlc-git-")));
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: main,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  g("init", "-q", "-b", "dev");
  const tree = g("write-tree");
  const commit = g("commit-tree", tree, "-m", "init");
  g("update-ref", "refs/heads/dev", commit);
  const worktree = join(main, ".claude", "worktrees", "wt");
  g("worktree", "add", "-q", worktree, "-b", "feat/wt", "dev");
  return { main, worktree };
}

describe("asking git", () => {
  const { main, worktree } = repoWithWorktree();

  it("finds the main checkout from the main checkout and from a worktree", () => {
    expect(mainCheckout(main)).toBe(main);
    expect(mainCheckout(worktree)).toBe(main);
  });

  it("finds the checkout root of a path that does not exist yet", () => {
    expect(checkoutRoot(join(worktree, "docs", "new", "file.md"))).toBe(worktree);
    expect(checkoutRoot(join(main, "x.md"))).toBe(main);
  });

  it("could not ask outside a repository: null, never a guess", () => {
    const outside = mkdtempSync(join(tmpdir(), "sdlc-norepo-"));
    expect(mainCheckout(outside)).toBeNull();
    expect(checkoutRoot(outside)).toBeNull();
  });

  it("canonicalises through symlinks and keeps a missing tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdlc-canon-"));
    mkdirSync(join(dir, "a"));
    expect(canonical(join(dir, "a", "missing", "f.md"))).toBe(
      join(realpathSync(dir), "a", "missing", "f.md"),
    );
  });
});
