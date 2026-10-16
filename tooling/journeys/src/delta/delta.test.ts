import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { boxDelta, comparePng, deltaExit, isSpurious, stepImages } from "./delta.mts";
import type { Row } from "./delta.mts";

const png = (fill: number, width = 4, height = 4, dot?: [number, number]) => {
  const p = new PNG({ width, height });
  p.data.fill(fill);
  if (dot) {
    const i = (dot[1] * width + dot[0]) * 4;
    p.data[i] = 255 - fill;
  }
  return PNG.sync.write(p);
};

describe("the delta", () => {
  it("tells identical, changed and resized apart, within a tolerance of 8", () => {
    expect(comparePng(png(100), png(100)).verdict).toBe("identical");
    expect(comparePng(png(100), png(105)).verdict).toBe("identical");
    expect(comparePng(png(100), png(100, 4, 4, [1, 1])).verdict).toBe("changed");
    expect(comparePng(png(100), png(100, 5, 4)).detail).toBe("4×4 → 5×4");
  });

  it("calls a mask that grew on an identical screenshot spurious, and only that", () => {
    expect(isSpurious("identical", 0.01, 0.05)).toBe(true);
    expect(isSpurious("identical", 0.01, 0.015)).toBe(false);
    expect(isSpurious("changed", 0.01, 0.5)).toBe(false);
    expect(isSpurious("identical", null, 0.5)).toBe(false);
  });

  it("matches boxes by element, ignoring the index, and keeps growth and narrowing apart", () => {
    const b = (from: string, width: number, x = 0) => ({
      x,
      y: 0,
      width,
      height: 10,
      from,
      provenance: "learned",
    });
    const d = boxDelta(
      [b("span[0]", 10), b("div[0]", 50), b("p[0]", 10)],
      [b("span[1]", 30), b("div[0]", 20), b("em[0]", 5)],
    );
    expect(d.grew.map((g) => g.from)).toEqual(["span[1]"]);
    expect(d.shrank.map((g) => g.from)).toEqual(["div[0]"]);
    expect(d.added.map((g) => g.from)).toEqual(["em[0]"]);
    expect(d.removed.map((g) => g.from)).toEqual(["p[0]"]);
  });

  it("enumerates steps, not overlays or a failed comparison's artefacts", () => {
    expect(
      stepImages([
        "docs/journeys/J1-x/p/happy/snapshots/01-a.png",
        "docs/journeys/J1-x/p/happy/snapshots/01-a-mask.png",
        "docs/journeys/J1-x/p/happy/snapshots/changed/01-a-diff.png",
        "docs/journeys/J1-x/p/happy/snapshots/01-a.png.mask.json",
      ]),
    ).toEqual(["docs/journeys/J1-x/p/happy/snapshots/01-a.png"]);
  });

  it("fails on a spurious mask or a step that did not hold", () => {
    const row = (over: Partial<Row>): Row => ({
      journey: "J1-x",
      step: "s",
      png: "p",
      old: null,
      held: true,
      verdict: "identical",
      detail: "",
      maskBefore: null,
      maskAfter: null,
      boxes: null,
      spurious: false,
      ...over,
    });
    expect(deltaExit([row({})])).toBe(0);
    expect(deltaExit([row({ spurious: true })])).toBe(1);
    expect(deltaExit([row({ held: false })])).toBe(1);
  });
});
