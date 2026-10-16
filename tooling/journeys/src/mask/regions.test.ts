import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { changedRegions, describeRegions } from "./regions.mts";

/**
 * The region finder exists to separate two diffs that are **the same size**.
 *
 * Every case below is built so that magnitude cannot tell them apart — that is
 * the point. A renamed organization and a shifted card edge both land around a
 * fraction of a percent, and the band was very nearly published to six lanes as
 * the thing to approve on.
 */

const blank = (w = 400, h = 200) => {
  const p = new PNG({ width: w, height: h });
  p.data.fill(255);
  return p;
};

const paint = (p: PNG, x0: number, y0: number, w: number, h: number) => {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * p.width + x) * 4;
      p.data[i] = 0;
      p.data[i + 1] = 0;
      p.data[i + 2] = 0;
      p.data[i + 3] = 255;
    }
  }
};

describe("changedRegions", () => {
  it("reports nothing when the images match", () => {
    expect(changedRegions(blank(), blank())).toEqual([]);
  });

  it("gives an exact box, not one rounded out to its cell", () => {
    // 20,30 13×9 is deliberately not aligned to the 8px grid in any dimension.
    // Reporting cell bounds would say 16,24 24×24 — the #923 defect arriving
    // inside the tool built to review it.
    const after = blank();
    paint(after, 20, 30, 13, 9);

    expect(changedRegions(blank(), after)).toEqual([{ x: 20, y: 30, width: 13, height: 9 }]);
  });

  it("merges the glyphs of a word into one run rather than one box each", () => {
    // Five 4px marks with 3px gaps — letters, not five separate changes.
    const after = blank();
    for (let i = 0; i < 5; i++) paint(after, 100 + i * 7, 50, 4, 10);

    const regions = changedRegions(blank(), after);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({ x: 100, y: 50, width: 32, height: 10 });
  });

  it("keeps genuinely separate changes apart", () => {
    // A chip at the top and an audit row far below: two regions, because that
    // is two places on the page, however small each is.
    const after = blank();
    paint(after, 10, 10, 30, 10);
    paint(after, 300, 170, 30, 10);

    expect(changedRegions(blank(), after)).toHaveLength(2);
  });

  /**
   * **The case the whole module exists for.**
   *
   * Both diffs below change a near-identical number of pixels. One is a name
   * getting longer; the other is a card edge moving one pixel. Approving on
   * size alone passes both, which is why the reviewer is given position.
   */
  it("tells a text run from a moved edge, at the same pixel count", () => {
    const rename = blank();
    paint(rename, 120, 40, 60, 11); // a name: short, wide-ish, one place

    const movedEdge = blank();
    paint(movedEdge, 350, 8, 1, 180); // a border: one pixel wide, spanning the card

    const [r] = changedRegions(blank(), rename);
    const [e] = changedRegions(blank(), movedEdge);

    // Comparable magnitude — the thing that makes them indistinguishable.
    const area = (b: { width: number; height: number }) => b.width * b.height;
    expect(Math.abs(area(r!) - area(e!))).toBeLessThan(500);

    // And entirely different shapes, which is what a reviewer can act on.
    expect(r!.height).toBeLessThan(20);
    expect(e!.height).toBeGreaterThan(100);
  });

  it("does not compare images of different sizes", () => {
    // A resize is its own verdict upstream; regions would be meaningless.
    expect(changedRegions(blank(400, 200), blank(400, 300))).toEqual([]);
  });

  it("ignores a difference under the tolerance", () => {
    const after = blank();
    const i = (50 * after.width + 50) * 4;
    after.data[i] = 250; // 5 under 255, within the tolerance of 8
    expect(changedRegions(blank(), after)).toEqual([]);
  });
});

describe("describeRegions", () => {
  it("says nothing when there is nothing to say", () => {
    expect(describeRegions([])).toBe("");
  });

  it("renders a box as x,y w×h", () => {
    expect(describeRegions([{ x: 12, y: 34, width: 56, height: 7 }])).toBe(
      " · 1 region: 12,34 56×7",
    );
  });

  it("caps the list, because a scattered diff is itself the finding", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ x: i, y: i, width: 2, height: 2 }));
    const out = describeRegions(many);
    expect(out).toContain("7 regions");
    expect(out).toContain("+3 more");
  });
});
