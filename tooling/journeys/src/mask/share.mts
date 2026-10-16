import type { Box } from "./boxes.mts";

/**
 * What share of an image the boxes cover, **overlap counted once**.
 *
 * Counted on a bitmap, not summed: `mergeBoxes` drops a box wholly inside
 * another and nothing else, so two that merely cross both survive and their
 * intersection would be added twice (measured: 11,616px summed against
 * 10,208px actually covered). The learner's pattern check, the delta and the recorder
 * all judge a mask by this one number.
 */
export function paintedShare(boxes: readonly Box[], width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  const painted = new Uint8Array(width * height);
  for (const box of boxes) {
    for (let y = Math.max(0, box.y); y < box.y + box.height && y < height; y++) {
      for (let x = Math.max(0, box.x); x < box.x + box.width && x < width; x++)
        painted[y * width + x] = 1;
    }
  }
  let covered = 0;
  for (const pixel of painted) covered += pixel;
  return covered / (width * height);
}
