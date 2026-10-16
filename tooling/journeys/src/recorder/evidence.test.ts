import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANGED_MARKER,
  FAILED_MARKER,
  duration,
  pathIsGreen,
  readPersonaMarker,
  renderPath,
  stepCount,
  stepStem,
  writePersonaMarker,
} from "./evidence.mts";
import type { StepRecord } from "./evidence.mts";

const step = (n: number, over: Partial<StepRecord> = {}): StepRecord => ({
  n,
  title: `Step ${n}`,
  note: "what happened",
  shot: `${stepStem(n, `Step ${n}`)}.png`,
  captures: [],
  rendered: [],
  files: [],
  verdict: "unchanged",
  settling: [],
  failed: false,
  ...over,
});

const meta = {
  id: "J4",
  title: "Signing In",
  path: "happy",
  intent: "sign in",
  persona: "An organizer",
};
const render = (steps: StepRecord[]) =>
  renderPath(meta, steps, { tookMs: 1234, recordedOn: "2026-10-15" });

describe("the narrative and its verification page", () => {
  it("is green until a step fails or changes, and the markers are in README.md", () => {
    expect(pathIsGreen(render([step(1)]).readme)).toBe(true);
    const failed = render([step(1, { failed: true })]);
    expect(failed.readme).toContain(FAILED_MARKER);
    expect(pathIsGreen(failed.readme)).toBe(false);
    const changed = render([
      step(1, { verdict: "changed", diff: { expected: "a.png", actual: "b.png", diff: "c.png" } }),
    ]);
    expect(changed.readme).toContain(CHANGED_MARKER);
    expect(changed.diff).not.toContain(CHANGED_MARKER);
    expect(pathIsGreen(changed.readme)).toBe(false);
  });

  it("keeps the failed marker out of the heading, so the anchor survives it", () => {
    const { readme, diff } = render([step(1, { failed: true })]);
    expect(readme).toContain("## 1. Step 1\n");
    expect(diff).toContain("README.md#1-step-1");
  });

  it("counts steps out of the narrative, and says when a step is not compared", () => {
    const { readme } = render([step(1), step(2, { verdict: "not compared" })]);
    expect(stepCount(readme)).toBe(2);
    expect(readme).toContain("**Not compared yet**");
  });

  it("strips trailing whitespace from captured text, which git diff --check refuses", () => {
    const { readme } = render([
      step(1, { captures: [{ kind: "text", label: "page", language: "text", body: "a\t\nb  " }] }),
    ]);
    expect(readme).toContain("```text\na\nb\n```");
  });

  it("reads a duration as a person would", () => {
    expect(duration(3_140)).toBe("3.1s");
    expect(duration(75_000)).toBe("1m 15s");
  });

  it("writes a persona marker once, and reads it back", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "journeys-marker-")));
    writePersonaMarker(dir, "organizer", "An organizer");
    expect(readPersonaMarker(dir)).toEqual({ key: "organizer", label: "An organizer" });
    expect(readPersonaMarker(join(dir, "missing"))).toBeNull();
  });
});
