import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { drawDiff, volatileBoxes } from "./boxes.mts";

/**
 * **The third image, proved by reading the pixels it paints.**
 *
 * `diff.md` has carried a *diff* column since #657 and always printed `—` in
 * it, because nothing produced the image. A test that only checked the file
 * exists would pass for a copy of the *after* screenshot, which is the failure
 * that would look most like success — so every claim below is a colour at a
 * coordinate.
 */
const RED: [number, number, number] = [217, 45, 32];

const png = (w: number, h: number, paint: (x: number, y: number) => [number, number, number]) => {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(out);
};

const at = (image: PNG, x: number, y: number): [number, number, number] => {
  const i = (y * image.width + x) * 4;
  return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
};

describe("drawDiff", () => {
  /**
   * A black page, and an *after* with two white pixels: one inside a mask box,
   * one outside it. The box is 6×6 at (10,2), so (12,4) is well inside its
   * 2px edge and (3,4) is nowhere near it.
   */
  const setUp = () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-diff-"));
    const before = join(dir, "before.png");
    const after = join(dir, "after.png");
    writeFileSync(
      before,
      png(20, 10, () => [0, 0, 0]),
    );
    writeFileSync(
      after,
      png(20, 10, (x, y) =>
        (x === 3 && y === 4) || (x === 12 && y === 4) ? [255, 255, 255] : [0, 0, 0],
      ),
    );
    return { dir, before, after, box: { x: 10, y: 2, width: 6, height: 6 } };
  };

  it("counts only what fell outside the mask", () => {
    const { dir, before, after, box } = setUp();
    expect(drawDiff(before, after, [box], join(dir, "diff.png"))).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("paints the leak solid red, and what the mask absorbed as a tint", () => {
    const { dir, before, after, box } = setUp();
    drawDiff(before, after, [box], join(dir, "diff.png"));
    const diff = PNG.sync.read(readFileSync(join(dir, "diff.png")));

    // The pixel that made the step red is the one thing on the page that is red.
    expect(at(diff, 3, 4)).toEqual(RED);
    // Inside the box: a white pixel tinted toward red, and not the solid red
    // of a leak — the two have to be tellable apart, because one is a finding
    // and the other is the mask doing its job.
    const absorbed = at(diff, 12, 4);
    expect(absorbed).not.toEqual(RED);
    expect(absorbed[0]).toBeGreaterThan(absorbed[2]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("dims everything that did not change, so the page stays readable under the red", () => {
    const { dir, before, after, box } = setUp();
    drawDiff(before, after, [box], join(dir, "diff.png"));
    const diff = PNG.sync.read(readFileSync(join(dir, "diff.png")));

    // Black dimmed toward white is grey — neither the original black nor red.
    const [r, g, b] = at(diff, 0, 0);
    expect(r).toBeGreaterThan(100);
    expect(r).toBe(g);
    expect(g).toBe(b);
    rmSync(dir, { recursive: true, force: true });
  });

  it("outlines the mask's boxes the way drawMask does", () => {
    const { dir, before, after, box } = setUp();
    drawDiff(before, after, [box], join(dir, "diff.png"));
    const diff = PNG.sync.read(readFileSync(join(dir, "diff.png")));

    // Top-left corner of the box is edge; the centre is not.
    expect(at(diff, box.x, box.y)).toEqual(RED);
    expect(at(diff, box.x + 3, box.y + 3)).not.toEqual(RED);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A resize cannot be diffed pixel for pixel, and painting a black rectangle
   * would read as *nothing differed* — the opposite of what happened. Null,
   * and no file, so the caller reports the resize it already knows about.
   */
  it("writes nothing and returns null when the page resized", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-diff-"));
    const before = join(dir, "before.png");
    const after = join(dir, "after.png");
    writeFileSync(
      before,
      png(20, 10, () => [0, 0, 0]),
    );
    writeFileSync(
      after,
      png(21, 10, () => [0, 0, 0]),
    );

    expect(drawDiff(before, after, [], join(dir, "diff.png"))).toBeNull();
    expect(existsSync(join(dir, "diff.png"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("volatileBoxes and a declared region", () => {
  /**
   * A white page; the *after* paints one block inside a declared box — a clock
   * — and one outside it. The declared box is 40×16 at (90,20).
   */
  const setUp = () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-declared-"));
    const before = join(dir, "before.png");
    const after = join(dir, "after.png");
    const inside = (x: number, y: number) => x >= 100 && x < 108 && y >= 24 && y < 32;
    const outside = (x: number, y: number) => x >= 10 && x < 18 && y >= 24 && y < 32;
    writeFileSync(
      before,
      png(200, 60, () => [255, 255, 255]),
    );
    writeFileSync(
      after,
      png(200, 60, (x, y) => (inside(x, y) || outside(x, y) ? [0, 0, 0] : [255, 255, 255])),
    );
    return { dir, before, after, declared: { x: 90, y: 20, width: 40, height: 16 } };
  };

  it("learns both regions when nothing is declared", () => {
    const { dir, before, after } = setUp();
    expect(volatileBoxes(before, after, [])).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  /*
   * A clock differs in more digits the longer apart two shots are, so a box
   * learned over a declared one measured elapsed time — and, once it swallowed
   * the declared box, `mergeBoxes` dropped the one that follows the element.
   */
  it("does not learn what a declared box already masks, and still learns the rest", () => {
    const { dir, before, after, declared } = setUp();
    const boxes = volatileBoxes(before, after, [], [declared]);
    expect(boxes).toHaveLength(1);
    expect(boxes![0]!.x).toBeLessThan(declared.x);
    rmSync(dir, { recursive: true, force: true });
  });
});
