import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, parseEnv } from "./load-env.mts";

let base: string;
let main: string;
let tree: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "load-env-"));
  main = join(base, "main");
  tree = join(main, ".claude", "worktrees", "x");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(main, "sdlc.config.ts"), "");
  writeFileSync(join(tree, "sdlc.config.ts"), "");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("parseEnv", () => {
  it("reads the usual dotenv shapes", () => {
    expect(
      parseEnv(
        `# comment\nA=1\nexport B = two \nC="x y\\nz"\nD='lit # not a comment'\nE=v # trailing\n\nbad line\n`,
      ),
    ).toEqual({ A: "1", B: "two", C: "x y\nz", D: "lit # not a comment", E: "v" });
  });
});

describe("loadEnv", () => {
  it("is a no-op under vitest unless forced", () => {
    writeFileSync(join(main, ".env"), "A=1\n");
    const env: NodeJS.ProcessEnv = { VITEST: "true" };
    expect(loadEnv({ cwd: main, env, mainCheckout: () => main })).toEqual([]);
    expect(env.A).toBeUndefined();
  });

  it("falls back to the main checkout from a worktree, and never overwrites", () => {
    writeFileSync(join(main, ".dev.vars"), "DATABASE_URL=main-db\nSET=file\n");
    writeFileSync(join(tree, ".env"), "DATABASE_URL=tree-db\n");
    const env: NodeJS.ProcessEnv = { SET: "shell" };
    const read = loadEnv({ cwd: tree, env, mainCheckout: () => main, force: true });
    expect(env.DATABASE_URL).toBe("tree-db");
    expect(env.SET).toBe("shell");
    expect(read).toEqual([join(tree, ".env"), join(main, ".dev.vars")]);
  });

  it("never takes NODE_ENV from a file", () => {
    writeFileSync(join(main, ".env"), "NODE_ENV=development\nX=1\n");
    const env: NodeJS.ProcessEnv = {};
    loadEnv({ cwd: main, env, mainCheckout: () => main, force: true });
    expect(env).toEqual({ X: "1" });
  });

  it("loads only this checkout when git cannot say where the main one is", () => {
    writeFileSync(join(main, ".env"), "A=1\n");
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnv({ cwd: tree, env, mainCheckout: () => null, force: true })).toEqual([]);
  });
});
