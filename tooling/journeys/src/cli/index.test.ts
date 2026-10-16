/**
 * `journeys index --check` is a gate a project puts in CI once it has
 * journeys: deterministic, read-only, nonzero on drift. And the Playwright
 * teardown that regenerates the index fails the run when it cannot.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeProject } from "../__fixtures__/app/project.mts";
import { regenerateIndex } from "../playwright/global-teardown.mts";
import { RUN_STAMP } from "../playwright/run-stamp.mts";
import { INDEX_CLI } from "./paths.mts";

let root = "";
const index = (...args: string[]) => {
  const r = spawnSync(process.execPath, [INDEX_CLI, ...args], { cwd: root, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
};
const readme = () => join(root, "docs/journeys/README.md");

beforeAll(() => {
  root = makeProject();
  mkdirSync(join(root, "docs/journeys"), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("journeys index --check", () => {
  it("reports drift on a page that has never been generated, and writes nothing", () => {
    const r = index("--check");
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("DRIFT docs/journeys/README.md");
    expect(existsSync(readme())).toBe(false);
  });

  it("passes on what the generator just wrote, and prints a line per page", () => {
    expect(index().status).toBe(0);
    const r = index("--check");
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain("ok    docs/journeys/README.md");
    expect(r.output).toMatch(/1 generated page\(s\) match the evidence/);
  });

  it("fails on a hand edit, leaves the edit in place, and does not consume the run stamp", () => {
    writeFileSync(readme(), readFileSync(readme(), "utf8") + "\nhand-written line\n");
    const stamp = join(root, "test-results", RUN_STAMP);
    mkdirSync(join(root, "test-results"), { recursive: true });
    writeFileSync(stamp, JSON.stringify({ startedAt: Date.now() }));
    const r = index("--check");
    expect(r.status, r.output).toBe(1);
    expect(readFileSync(readme(), "utf8")).toContain("hand-written line");
    expect(existsSync(stamp)).toBe(true);
  });

  it("refuses an argument it does not know rather than writing", () => {
    expect(index("--chek").status).toBe(2);
  });
});

describe("the Playwright teardown", () => {
  it("returns on exit 0", () => {
    expect(() => regenerateIndex("/x", () => ({ status: 0, signal: null }))).not.toThrow();
  });
  it("fails the run on a nonzero exit", () => {
    expect(() => regenerateIndex("/x", () => ({ status: 1, signal: null }))).toThrow(
      /JOURNEY-070.*exited 1/,
    );
  });
  it("fails the run when the index was killed by a signal", () => {
    expect(() => regenerateIndex("/x", () => ({ status: null, signal: "SIGKILL" }))).toThrow(
      /JOURNEY-070.*SIGKILL/,
    );
  });
  it("fails the run against a real index that cannot load its config", () => {
    const broken = makeProject();
    writeFileSync(join(broken, "journeys.config.mts"), "export default {{ not a module\n");
    try {
      expect(() => regenerateIndex(broken)).toThrow(/JOURNEY-070/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
