import type { FileCoverage } from "./coverage-lib.mts";

const loc = (line: number, col: number) => ({
  start: { line, column: col },
  end: { line, column: col + 9 },
});

/**
 * A file whose statement i sits on line i+1, with the given hit counts.
 * Branch and function i sit on line i+1 at column 20 and 40, unless `branchLines`
 * moves a branch (to model a run that numbered its branches differently).
 */
export function fileCov(
  hits: number[],
  branches: number[][] = [],
  fns: number[] = [],
  branchLines: number[] = [],
): FileCoverage {
  const statementMap: FileCoverage["statementMap"] = {};
  const s: Record<string, number> = {};
  hits.forEach((h, i) => {
    statementMap[i] = loc(i + 1, 0);
    s[i] = h;
  });
  const b: Record<string, number[]> = {};
  const branchMap: Record<string, unknown> = {};
  branches.forEach((arms, i) => {
    b[i] = arms;
    branchMap[i] = { type: "branch", loc: loc(branchLines[i] ?? i + 1, 20), locations: [] };
  });
  const f: Record<string, number> = {};
  const fnMap: Record<string, unknown> = {};
  fns.forEach((h, i) => {
    f[i] = h;
    fnMap[i] = { name: `fn${i}`, loc: loc(i + 1, 40) };
  });
  return { statementMap, s, b, f, fnMap, branchMap };
}
