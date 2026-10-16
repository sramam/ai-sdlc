import { afterEach, describe, expect, it } from "vitest";
import { cleanup, commit, initRepo, tempDir, write } from "./__fixtures__/plan/temp-repo.ts";
import { itemCheck, pathsNamed } from "./item-check.mts";
import { DEFAULT_DIRS } from "./plan-lib.mts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop() ?? "");
});

describe("pathsNamed", () => {
  it("finds paths and skips commands, URLs and prose slashes", () => {
    const text =
      "Touches `apps/web/src/a.ts`, docs/kit/hooks.md and `packages/db/`.\nRun `pnpm plan:check --stage plan`. See https://x.dev/a/b.md and/or `sdlc.config.ts`.";
    expect(pathsNamed(text, (p) => p === "sdlc.config.ts")).toEqual([
      "apps/web/src/a.ts",
      "docs/kit/hooks.md",
      "packages/db/",
      "sdlc.config.ts",
    ]);
  });
});

describe("itemCheck", () => {
  function setup(body: string): { d: string; lines: string[]; run: () => number } {
    const d = initRepo(tempDir());
    dirs.push(d);
    write(d, "src/a.ts", "1");
    write(d, "src/b.ts", "1");
    commit(d, "init", 1_700_000_000);
    write(d, "docs/plan/items/F01-001-x.md", `---\nid: F01-001\ntitle: x\n---\n${body}\n`);
    commit(d, "plan", 1_700_000_100);
    const lines: string[] = [];
    return { d, lines, run: () => itemCheck(d, DEFAULT_DIRS, "f01-001", (l) => lines.push(l)) };
  }
  it("reports what moved since the item was written", () => {
    const { d, lines, run } = setup("Changes `src/a.ts` and `src/b.ts`.");
    write(d, "src/a.ts", "2");
    commit(d, "change a", 1_700_000_200);
    expect(run()).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/MOVED\s+1\s+src\/a\.ts/);
    expect(out).toMatch(/steady\s+src\/b\.ts/);
  });
  it("could not ask when the item names no path", () => {
    const { lines, run } = setup("Nothing concrete.");
    expect(run()).toBe(1);
    expect(lines.join()).toContain("names no path");
  });
  it("refuses an unknown item", () => {
    const { d } = setup("x");
    expect(itemCheck(d, DEFAULT_DIRS, "F09-009", () => {})).toBe(2);
  });
});
