import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchToSweep, sweepScratch } from "./scratch.mts";

/** This package's `src/`, which is where a second caller would appear. */
const SRC = new URL("../", import.meta.url).pathname;

/** A `test-results/` with the given entries, in a throwaway directory. */
function scratch(...entries: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "journey-scratch-"));
  for (const entry of entries) {
    mkdirSync(join(root, "test-results", entry), { recursive: true });
    writeFileSync(join(root, "test-results", entry, "a-file"), "x");
  }
  return root;
}

describe("the journey scratch sweep", () => {
  it("takes everything but Playwright's own directory", () => {
    expect(
      scratchToSweep(["email-outbox", "journey-baseline", "mask-evidence", "playwright"]),
    ).toEqual(["email-outbox", "journey-baseline", "mask-evidence"]);
  });

  /**
   * **The point of a keep-list.** The defect was a directory nobody swept, so
   * a sweep-list would reproduce it on the next one somebody adds. A name this
   * file has never heard of goes.
   */
  it("takes a directory nobody has thought of yet", () => {
    expect(scratchToSweep(["something-new"])).toEqual(["something-new"]);
  });

  it("removes them from disk, and leaves Playwright's", () => {
    const root = scratch("email-outbox", "journey-baseline", "playwright");
    expect(sweepScratch(root).sort()).toEqual(["email-outbox", "journey-baseline"]);
    expect(readdirSync(join(root, "test-results"))).toEqual(["playwright"]);
  });

  it("honours a configured scratch root and keep-list", () => {
    const root = mkdtempSync(join(tmpdir(), "journey-scratch-cfg-"));
    for (const entry of ["outbox", "pw", "cache"]) {
      mkdirSync(join(root, "tmp", "e2e", entry), { recursive: true });
    }
    expect(sweepScratch(root, { scratchRoot: "tmp/e2e", keep: ["pw", "cache"] })).toEqual([
      "outbox",
    ]);
    expect(readdirSync(join(root, "tmp", "e2e")).sort()).toEqual(["cache", "pw"]);
  });

  /** A fresh checkout has no `test-results/`, and the stack makes what it needs. */
  it("is silent when there is nothing there", () => {
    expect(sweepScratch(mkdtempSync(join(tmpdir(), "journey-scratch-empty-")))).toEqual([]);
  });
});

describe("where it is wired", () => {
  /**
   * **Once per stack, which is what makes a three-pass learning run safe.**
   *
   * The learner starts one stack and runs the suite more than once; pass 2 is
   * diffed against pass 1, including the mail pass 1 captured. A second caller
   * in Playwright's `globalSetup`, a fixture or a spec would run *between* the
   * passes and delete it — and the failure would be a mask learned against half
   * the evidence, which is permanent and looks like a volatile region.
   *
   * So the caller count is the assertion, not a comment saying so. door_nexa
   * asked `git grep` across the repository; this package is the only place the
   * sweep is imported from, so its own `src/` is walked instead (the files need
   * not be committed for the check to hold).
   */
  it("is called from the stack host and nowhere else", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const callers = walk(SRC)
      .filter((f) => /\.m?ts$/.test(f) && !/\.test\.ts$/.test(f))
      .filter((f) => /\bsweepScratch\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f))
      .filter((f) => f !== join("stack", "scratch.mts"));

    expect(
      callers,
      "the sweep must run once per stack. A learning run starts one stack and runs " +
        "the suite more than once, so a caller in test setup deletes pass 1's captured " +
        "mail between the passes — and pass 2 is diffed against it",
    ).toEqual([join("stack", "host.mts")]);
  });

  /*
   * door_nexa compared `MANAGED_BY_PLAYWRIGHT` with the `outputDir` its
   * `playwright.config.ts` declares. The Playwright config arrives with the
   * recorder in step 3; until then there is nothing to compare against, and a
   * comparison with nothing is a pass that proves nothing.
   */
  it.todo("keeps exactly the directory the Playwright config declares (recorder, step 3)");
});
