import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkNode, checkPnpm, linkEnvFile, runBootstrap } from "./bootstrap.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";

let base: string;
let main: string;
let tree: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "bootstrap-"));
  main = join(base, "main");
  tree = join(main, ".claude", "worktrees", "x");
  mkdirSync(tree, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("version checks", () => {
  it("node: a major in .nvmrc matches any minor", () => {
    expect(checkNode("v24.3.0", "24\n").state).toBe("ok");
    expect(checkNode("v22.1.0", "24").state).toBe("fail");
    expect(checkNode("v24.3.0", "24.3.1").state).toBe("fail");
    expect(checkNode("v24.3.0", null).state).toBe("n/a");
  });
  it("pnpm: missing fails, a different major fails, a different minor is reported", () => {
    expect(checkPnpm(null, "pnpm@10.28.2").state).toBe("fail");
    expect(checkPnpm("9.0.0", "pnpm@10.28.2").state).toBe("fail");
    expect(checkPnpm("10.20.0", "pnpm@10.28.2")).toMatchObject({
      state: "ok",
      detail: expect.stringMatching(/pins 10\.28\.2/),
    });
    expect(checkPnpm("10.28.2", "pnpm@10.28.2+sha512.abc").state).toBe("ok");
  });
});

describe("linkEnvFile", () => {
  it("symlinks a file the main checkout has and this one lacks, without reading it", () => {
    writeFileSync(join(main, ".dev.vars"), "SECRET=1");
    const c = linkEnvFile(tree, main, ".dev.vars", (t, p) => symlinkSync(t, p));
    expect(c.state).toBe("ok");
    expect(lstatSync(join(tree, ".dev.vars")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(tree, ".dev.vars"))).toBe(join("..", "..", "..", ".dev.vars"));
    // Second run: already linked, nothing done.
    expect(
      linkEnvFile(tree, main, ".dev.vars", () => {
        throw new Error("should not link twice");
      }).detail,
    ).toMatch(/linked to/);
  });
  it("leaves an own copy alone, and says a copy can drift", () => {
    writeFileSync(join(main, ".env"), "A=1");
    writeFileSync(join(tree, ".env"), "A=2");
    expect(
      linkEnvFile(tree, main, ".env", () => {
        throw new Error("no");
      }).detail,
    ).toMatch(/own copy/);
  });
  it("is n/a when the main checkout has none", () => {
    expect(linkEnvFile(tree, main, ".env", () => {}).state).toBe("n/a");
  });
});

describe("runBootstrap", () => {
  const healthy = (gitDir: string, common: string) =>
    scriptedExec([
      ["pnpm --version", result(0, "10.28.2\n")],
      ["git --version", result(0, "git version 2.50.0\n")],
      ["git lfs version", result(0, "git-lfs/3.7.0\n")],
      ["gh --version", result(0, "gh version 2.97.0\n")],
      [/--git-dir$/, result(0, `${gitDir}\n`)],
      [/--git-common-dir$/, result(0, `${common}\n`)],
    ]);

  it("prints one line per check and exits 0 when healthy, linking env files in a worktree", async () => {
    writeFileSync(join(tree, ".nvmrc"), "24");
    writeFileSync(join(tree, "package.json"), JSON.stringify({ packageManager: "pnpm@10.28.2" }));
    mkdirSync(join(tree, "node_modules"));
    writeFileSync(join(main, ".dev.vars"), "X=1");
    const lines: string[] = [];
    const { exit, checks } = await runBootstrap({
      exec: healthy(join(main, ".git", "worktrees", "x"), join(main, ".git")),
      root: tree,
      nodeVersion: "v24.3.0",
      log: (l) => lines.push(l),
    });
    expect(exit).toBe(0);
    expect(checks.map((c) => c.name)).toEqual([
      "node",
      "pnpm",
      "git",
      "git-lfs",
      "gh",
      "node_modules",
      "checkout",
      ".dev.vars",
      ".env",
    ]);
    expect(lines).toHaveLength(checks.length + 1);
    expect(lstatSync(join(tree, ".dev.vars")).isSymbolicLink()).toBe(true);
  });

  it("fails on missing node_modules, warns on missing git-lfs and gh; could-not-ask outside a repository", async () => {
    const exec = scriptedExec([
      ["pnpm --version", result(0, "10.28.2\n")],
      ["git --version", result(0, "git version 2.50.0\n")],
      ["git lfs version", result(1, "", "git: 'lfs' is not a git command. See 'git --help'.")],
      ["gh --version", result(127)],
      [/^git rev-parse/, result(128, "", "fatal: not a git repository")],
    ]);
    const { exit, checks } = await runBootstrap({
      exec,
      root: main,
      nodeVersion: "v24.3.0",
      log: () => {},
    });
    expect(exit).toBe(1);
    const by = Object.fromEntries(checks.map((c) => [c.name, c.state]));
    expect(by).toMatchObject({
      "git-lfs": "warn",
      gh: "warn",
      node_modules: "fail",
      checkout: "could-not-ask",
      node: "n/a",
    });
  });

  it("a required check that could not ask exits 2, never 0", async () => {
    mkdirSync(join(main, "node_modules"));
    const exec = scriptedExec([
      ["pnpm --version", result(0, "10.28.2\n")],
      ["git --version", result(0, "git version 2.50.0\n")],
      ["git lfs version", result(0, "git-lfs/3.7.0\n")],
      ["gh --version", result(0, "gh\n")],
      [/^git rev-parse/, result(128, "", "fatal: not a git repository")],
    ]);
    expect(
      (await runBootstrap({ exec, root: main, nodeVersion: "v24.0.0", log: () => {} })).exit,
    ).toBe(2);
  });

  it("missing gh and git-lfs alone are warnings: exit 0", async () => {
    mkdirSync(join(main, "node_modules"));
    const exec = scriptedExec([
      ["pnpm --version", result(0, "10.28.2\n")],
      ["git --version", result(0, "git version 2.50.0\n")],
      ["git lfs version", result(1, "", "git: 'lfs' is not a git command.")],
      ["gh --version", result(127)],
      [/--git-dir$/, result(0, `${join(main, ".git")}\n`)],
      [/--git-common-dir$/, result(0, `${join(main, ".git")}\n`)],
    ]);
    const lines: string[] = [];
    const out = await runBootstrap({
      exec,
      root: main,
      nodeVersion: "v24.0.0",
      log: (l) => lines.push(l),
    });
    expect(out.exit).toBe(0);
    expect(lines.at(-1)).toMatch(/2 warning/);
  });

  it("git itself is required: missing git fails, git timing out exits 2", async () => {
    mkdirSync(join(main, "node_modules"));
    const base: Array<[RegExp | string, ReturnType<typeof result>]> = [
      ["pnpm --version", result(0, "10.28.2\n")],
      ["git lfs version", result(0, "git-lfs/3.7.0\n")],
      ["gh --version", result(0, "gh\n")],
      [/--git-dir$/, result(0, `${join(main, ".git")}\n`)],
      [/--git-common-dir$/, result(0, `${join(main, ".git")}\n`)],
    ];
    const missing = scriptedExec([["git --version", result(127)], ...base]);
    expect(
      (await runBootstrap({ exec: missing, root: main, nodeVersion: "v24.0.0", log: () => {} }))
        .exit,
    ).toBe(1);
    const slow = scriptedExec([["git --version", { ...result(null), timedOut: true }], ...base]);
    expect(
      (await runBootstrap({ exec: slow, root: main, nodeVersion: "v24.0.0", log: () => {} })).exit,
    ).toBe(2);
  });
});
