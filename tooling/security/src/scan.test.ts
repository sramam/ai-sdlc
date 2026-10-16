import { describe, expect, it } from "vitest";
import { result as execResult, scriptedExec } from "../../core/src/exec.mts";
import { matchesGlob } from "./glob.mts";
import { parseArgs, runScan } from "./scan.mts";
import { tempRepo } from "./test-helpers.mts";
import { exitCode, result } from "./types.mts";

describe("parseArgs", () => {
  it("defaults to every check", () => {
    expect(parseArgs([])).toEqual({
      only: ["secrets", "deps", "licenses", "install-scripts", "release-age"],
      staged: false,
    });
  });
  it("takes --only, comma-separated or with =", () => {
    expect(parseArgs(["--only", "deps,licenses"])).toEqual({
      only: ["deps", "licenses"],
      staged: false,
    });
    expect(parseArgs(["--only=secrets"])).toEqual({ only: ["secrets"], staged: false });
  });
  it("--staged implies secrets and refuses any other check", () => {
    expect(parseArgs(["--staged"])).toEqual({ only: ["secrets"], staged: true });
    expect(parseArgs(["--staged", "--only", "deps"])).toEqual({
      error: "--staged applies to secrets only",
    });
  });
  it("refuses unknown checks and arguments", () => {
    expect(parseArgs(["--only", "virus"])).toHaveProperty("error");
    expect(parseArgs(["--fast"])).toHaveProperty("error");
  });
});

describe("exitCode", () => {
  it("is 1 on any fail, 2 on could-not-run without a fail, else 0", () => {
    const pass = result("deps", "pass", "");
    const cnr = result("deps", "could-not-run", "");
    const fail = result("deps", "fail", "");
    expect(exitCode([pass])).toBe(0);
    expect(exitCode([pass, cnr])).toBe(2);
    expect(exitCode([cnr, fail])).toBe(1);
  });
});

describe("runScan", () => {
  it("prints one line per check, and holds the verdict when one could not run", async () => {
    const out: string[] = [];
    const exec = scriptedExec([["pnpm audit --json", execResult(1, "", "getaddrinfo ENOTFOUND")]]);
    const code = await runScan(
      { only: ["deps", "licenses"], staged: false },
      { exec, root: tempRepo({}), log: (l) => out.push(l) },
    );
    expect(code).toBe(2);
    expect(out[1]).toMatch(/^deps {12}could-not-run {2}pnpm audit gave no report/);
    expect(out[2]).toMatch(/^licenses {8}could-not-run {2}no node_modules/);
  });

  it("fails on an invalid config before running anything", async () => {
    const out: string[] = [];
    const exec = scriptedExec([]);
    const root = tempRepo({
      "security.config.json": JSON.stringify({
        secrets: { allow: [{ path: "a", pattern: "b", reason: "x" }] },
      }),
    });
    expect(
      await runScan({ only: ["deps"], staged: false }, { exec, root, log: (l) => out.push(l) }),
    ).toBe(1);
    expect(exec.calls).toEqual([]);
    expect(out[0]).toMatch(/^config +fail +security.config.json is invalid/);
  });
});

describe("matchesGlob", () => {
  it("lets ** cross directories and * stay inside one", () => {
    expect(matchesGlob("a/b/c.txt", "a/**")).toBe(true);
    expect(matchesGlob("c.txt", "**/c.txt")).toBe(true);
    expect(matchesGlob("a/b/c.txt", "a/*.txt")).toBe(false);
    expect(matchesGlob("a/c.txt", "a/*.txt")).toBe(true);
    expect(matchesGlob("a.c", "a.c")).toBe(true);
    expect(matchesGlob("abc", "a.c")).toBe(false);
  });
});
