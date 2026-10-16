import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { pageDiff } from "./page-diff.mts";

/**
 * **A diff picture nobody checks is a picture.** These assert the three things
 * a reader relies on when they glance at one: that identical pages show no
 * red, that a changed region shows red *where it changed*, and that a page
 * which changed size says so rather than reporting a total rewrite.
 */
const page = (w: number, h: number, paint?: (x: number, y: number) => number | undefined) => {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = paint?.(x, y) ?? 255;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
};

describe("two months of one statement, side by side", () => {
  it("shows no difference between identical pages", () => {
    const a = page(40, 20);
    const d = pageDiff(a, page(40, 20));
    expect(d.pixels).toBe(0);
    expect(d.ratio).toBe(0);
    expect(d.resized).toBeUndefined();
  });

  it("counts only the pixels that changed", () => {
    // One 4x3 block differs — the shape a changed figure or a moved rule takes.
    const changed = (x: number, y: number) => (x < 4 && y < 3 ? 0 : 255);
    const d = pageDiff(page(40, 20), page(40, 20, changed));
    expect(d.pixels).toBe(12);
    expect(d.ratio).toBeCloseTo(12 / 800, 6);
  });

  it("tints the later month, and leaves the earlier one untouched", () => {
    const d = pageDiff(
      page(10, 10),
      page(10, 10, (x, y) => (x === 0 && y === 0 ? 0 : 255)),
    );
    const out = PNG.sync.read(d.png);

    // The right-hand page starts after the left page plus the gap.
    const right = (10 + 24) * 4;
    expect(out.data[right]).toBe(255); // red channel forced up
    expect(out.data[right + 1]).toBeLessThan(100); // green knocked down
    // The same pixel on the left-hand page is the original, undisturbed.
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([255, 255, 255]);
  });

  /**
   * **A page that changed size has already drifted**, so this reports rather
   * than throws — #902's class is a statement that grew a page, and a helper
   * that refused to draw it would hide the very thing worth looking at.
   */
  it("reports a size change instead of refusing to draw one", () => {
    const d = pageDiff(page(40, 20), page(40, 30));
    expect(d.resized).toEqual({ was: "40x20", now: "40x30" });
    expect(PNG.sync.read(d.png).height).toBe(30);
  });

  /**
   * And it compares only the overlap. Counting the non-overlapping region as
   * "different" would make any size change read as a total rewrite — a number
   * so large it tells a reviewer nothing, drowning the real difference.
   */
  it("compares only where both pages have a pixel", () => {
    const d = pageDiff(page(40, 20), page(40, 30));
    expect(d.pixels).toBe(0);
  });
});
