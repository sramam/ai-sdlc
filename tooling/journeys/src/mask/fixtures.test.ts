import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";
import {
  MASK_VERSION,
  MAX_DECLARED_BOX,
  MAX_STEP_COVERAGE,
  compareMasked,
  drawMask,
  exercisedBy,
  uncoveredDates,
} from "./boxes.mts";
import type { MaskBox } from "./boxes.mts";

/**
 * **One real recording, so the core is proved against what it will be handed.**
 *
 * Every other suite here builds its PNGs in memory: RGBA, tiny, and exactly the
 * shape the author expected. A real screenshot is none of those — this one is a
 * 1280×720 **RGB** PNG Playwright wrote, with the mask door_nexa's learner stored
 * beside it (J40 `the-last-admin/01`, copied verbatim; `__fixtures__/` is not
 * evidence and is not under the LFS filter `docs/journeys/` carries).
 *
 * It replaces nothing door_nexa had: none of the ported suites read the
 * recordings tree. It exists because the step-1 code paths that touch a file —
 * decode, compare, paint — were otherwise only ever exercised on synthetic input.
 */
const FIXTURE = new URL("../__fixtures__/J40-last-admin/", import.meta.url).pathname;
const SHOT = join(FIXTURE, "01-only-admin.png");
const stored = JSON.parse(readFileSync(join(FIXTURE, "01-only-admin.png.mask.json"), "utf8")) as {
  version: number;
  boxes: MaskBox[];
};

const scratch = mkdtempSync(join(tmpdir(), "journeys-fixture-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The fixture, with one rectangle painted solid magenta. */
function paintedCopy(name: string, box: { x: number; y: number; width: number; height: number }) {
  const png = PNG.sync.read(readFileSync(SHOT));
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = 255;
      png.data[i + 1] = 0;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
    }
  }
  const out = join(scratch, name);
  writeFileSync(out, PNG.sync.write(png));
  return out;
}

describe("a stored mask from a real recording", () => {
  it("is on the current rule", () => {
    // A mask from an older rule is discarded when learning, not unioned with.
    expect(stored.version).toBe(MASK_VERSION);
  });

  it("stays under both coverage ceilings", () => {
    const covered = drawMask(SHOT, stored.boxes, join(scratch, "drawn.png"));
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThan(MAX_STEP_COVERAGE);
    for (const box of stored.boxes.filter((b) => b.provenance === "declared")) {
      expect((box.width * box.height) / (1280 * 720)).toBeLessThan(MAX_DECLARED_BOX);
    }
  });

  it("compares a screenshot to itself as the same", () => {
    expect(compareMasked(SHOT, SHOT, stored.boxes)).toEqual({ kind: "same" });
  });

  it("absorbs a change inside a box, and credits that box", () => {
    const inside = stored.boxes[1]!;
    const changed = paintedCopy("inside.png", {
      x: inside.x + 2,
      y: inside.y + 2,
      width: 10,
      height: 6,
    });
    expect(compareMasked(SHOT, changed, stored.boxes)).toEqual({ kind: "same" });
    expect(exercisedBy(SHOT, changed, stored.boxes).map((b) => b.from)).toContain(inside.from);
  });

  it("reports a change outside every box", () => {
    const changed = paintedCopy("outside.png", { x: 40, y: 40, width: 10, height: 10 });
    const verdict = compareMasked(SHOT, changed, stored.boxes);
    expect(verdict.kind).toBe("changed");
    expect(verdict.kind === "changed" && verdict.pixels).toBe(100);
  });

  it("covers the declared dates it was learned for", () => {
    const declared = stored.boxes.filter((b) => b.provenance === "declared");
    const dates = declared.map((b) => ({
      x: b.x + 1,
      y: b.y + 1,
      width: b.width - 2,
      height: b.height - 2,
      path: b.from,
    }));
    expect(uncoveredDates(dates, stored.boxes)).toEqual([]);
  });
});
