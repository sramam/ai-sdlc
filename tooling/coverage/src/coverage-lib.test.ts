import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFloors,
  END,
  fingerprint,
  merge,
  renderReport,
  replaceBlock,
  stamp,
  stampedFingerprint,
  START,
  summarise,
  underPrefix,
} from "./coverage-lib.mts";
import type { CoverageJson } from "./coverage-lib.mts";
import { fileCov } from "./fixtures.test-helper.mts";

const ROOT = "/repo";

describe("merge", () => {
  it("sums counters per file and keeps files only one side has", () => {
    const unit: CoverageJson = { "/repo/a.ts": fileCov([1, 0, 0], [[1, 0]]) };
    const integ: CoverageJson = {
      "/repo/a.ts": fileCov([0, 2, 0], [[0, 3]]),
      "/repo/b.ts": fileCov([1]),
    };
    const merged = merge(unit, integ);
    expect(merged["/repo/a.ts"]!.s).toEqual({ 0: 1, 1: 2, 2: 0 });
    expect(merged["/repo/a.ts"]!.b).toEqual({ 0: [1, 3] });
    expect(Object.keys(merged).sort()).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  it("matches by location, not key: v8 numbers branches per run", () => {
    // Key 0 is line 1 in one run and line 5 in the other: different code.
    const merged = merge(
      { "/repo/a.ts": fileCov([1], [[1]], [], [1]) },
      { "/repo/a.ts": fileCov([1], [[0]], [], [5]) },
    );
    expect(Object.values(merged["/repo/a.ts"]!.b)).toEqual([[1], [0]]);
    expect(summarise(merged).counts.branches).toEqual([1, 2]);
  });

  it("never mutates its inputs, so the unit figure survives the merge", () => {
    const unit: CoverageJson = { "/repo/a.ts": fileCov([1, 0]) };
    const before = JSON.stringify(unit);
    merge(unit, { "/repo/a.ts": fileCov([0, 1]) });
    expect(JSON.stringify(unit)).toBe(before);
  });
});

describe("summarise", () => {
  it("derives lines from the statement map, and counts branch arms", () => {
    const cov = fileCov(
      [1, 0, 1, 1],
      [
        [1, 0],
        [1, 1],
      ],
      [1, 0],
    );
    // Two statements on line 1: covered if either ran.
    cov.statementMap[1] = { start: { line: 1, column: 10 }, end: { line: 1, column: 20 } };
    const s = summarise({ "/repo/a.ts": cov });
    expect(s.counts.statements).toEqual([3, 4]);
    expect(s.counts.lines).toEqual([3, 3]);
    expect(s.counts.branches).toEqual([3, 4]);
    expect(s.functions).toBe(50);
  });

  it("an empty set is 100%, never NaN", () => {
    expect(summarise({}).lines).toBe(100);
  });
});

describe("floors", () => {
  const cov: CoverageJson = {
    "/repo/tooling/ci/src/a.ts": fileCov([1, 1, 1, 0], [[1, 1]]),
    "/repo/tooling/core/src/b.ts": fileCov([0, 0], [[0, 1]]),
  };

  it("applies per path prefix, on a segment boundary", () => {
    expect(underPrefix("tooling/ci/src/a.ts", "tooling/ci")).toBe(true);
    expect(underPrefix("tooling/ci/src/a.ts", "tooling/ci/")).toBe(true);
    expect(underPrefix("tooling/core/src/b.ts", "tooling/c")).toBe(false);
    expect(underPrefix("anything.ts", ".")).toBe(true);
  });

  it("passes, fails with each shortfall named, and treats an unmatched prefix as empty", () => {
    const results = applyFloors(cov, ROOT, {
      "tooling/ci": { lines: 75, branches: 100 },
      "tooling/core": { lines: 10, branches: 60 },
      "tooling/typo": { lines: 1, branches: 1 },
    });
    expect(results.map((r) => [r.prefix, r.state])).toEqual([
      ["tooling/ci", "pass"],
      ["tooling/core", "fail"],
      ["tooling/typo", "empty"],
    ]);
    expect(results[1]!.shortfalls).toEqual(["lines: 0.00% < 10%", "branches: 50.00% < 60%"]);
  });

  it("no floors is no results", () => {
    expect(applyFloors(cov, ROOT, {})).toEqual([]);
  });
});

describe("fingerprint", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "cov-fp-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is stable for the same content and moves with content and mode", () => {
    const a = join(dir, "a.ts");
    writeFileSync(a, "export const x = 1;\n");
    const first = fingerprint(dir, [a], "merged");
    expect(fingerprint(dir, [a, a], "merged")).toBe(first);
    expect(fingerprint(dir, [a], "unit")).not.toBe(first);
    writeFileSync(a, "export const x = 2;\n");
    expect(fingerprint(dir, [a], "merged")).not.toBe(first);
  });
});

describe("the report block", () => {
  const input = (floors = {}, judged = true) => ({
    merged: { "/repo/tooling/ci/src/a.ts": fileCov([1, 0]) },
    root: ROOT,
    floors,
    suites: "the unit suite",
    judged,
    moduleOf: () => "tooling/ci",
    at: { sha: "abc1234", branch: "dev" },
  });

  it("says n/a when no floors are declared", () => {
    const block = renderReport(input());
    expect(block.startsWith(START)).toBe(true);
    expect(block.endsWith(END)).toBe(true);
    expect(block).toContain("**n/a**");
    expect(block).toContain("| `tooling/ci` | 50.0% |");
  });

  it("a run that does not judge says so beside each floor", () => {
    const block = renderReport(input({ "tooling/ci": { lines: 90, branches: 0 } }, false));
    expect(block).toContain("reported, not judged");
    expect(block).not.toContain("**FAIL**");
  });

  it("rewrites idempotently and keeps text outside the markers", () => {
    const block = renderReport(input());
    const created = replaceBlock(null, block);
    expect(replaceBlock(created, block)).toBe(created);
    const edited = `# Mine\n\nprose before\n\n${block}\n\nprose after\n`;
    const other = block.replace("abc1234", "def5678");
    const rewritten = replaceBlock(edited, other);
    expect(rewritten).toBe(`# Mine\n\nprose before\n\n${other}\n\nprose after\n`);
    expect(replaceBlock(rewritten, other)).toBe(rewritten);
    expect(replaceBlock("# no markers\n", block)).toBe(`# no markers\n\n${block}\n`);
  });

  it("is written unstamped and stamped only by stamp()", () => {
    const text = replaceBlock(null, renderReport(input()));
    expect(stampedFingerprint(text)).toBeNull();
    expect(stampedFingerprint(stamp(text, "0123456789abcdef"))).toBe("0123456789abcdef");
    expect(stampedFingerprint(null)).toBeNull();
  });
});
