import { PNG } from "pngjs";

/**
 * **Where** two screenshots differ, as a handful of boxes.
 *
 * ## A percentage cannot answer the question being asked
 *
 * The journey fixture rename moves **text**: an organization's name in a
 * sidebar chip, a staff account's name in an audit row. Measured across J39,
 * every such diff came in at 0.04%–0.42% of pixels with masks unchanged — and
 * that band was offered to six recording lanes as the signature to approve on.
 *
 * It is not a signature. **A one-line layout shift sits in the same band**, so
 * "small diff, approve it" is a check that cannot fail: thirteen journeys each
 * waved through on magnitude is how a real regression lands with the rename.
 * The discriminator is *position*:
 *
 * > A changed region covering a run of text is a renamed fixture or a new
 * > value. One that **crosses the edge of a declared box**, or sits where
 * > nothing renders text, is a layout change — whatever its size.
 *
 * The second half is the load-bearing one, because a reviewer can falsify it
 * knowing nothing about which names were changed.
 *
 * ## Cells, so a word is one region rather than forty
 *
 * Per-pixel components return a box per glyph. Changed pixels are marked on an
 * 8px grid and the *cells* are connected 8-way, which merges the letters of a
 * word and the words of a line into the run somebody actually compares against
 * a name.
 *
 * **Each extent is then taken from real pixels, not from the grid.** Reporting
 * the cell bounds would round every box outward by up to 7px — which is the
 * #923 defect (`floor(left) + ceil(width)`, far edge lost in 50.1% of rects)
 * arriving inside the tool built to review it.
 */
export type Region = { x: number; y: number; width: number; height: number };

/** Per-channel tolerance, matching `comparePng` — one-bit noise is not a change. */
const TOLERANCE = 8;
const CELL = 8;

export function changedRegions(a: PNG, b: PNG): Region[] {
  if (a.width !== b.width || a.height !== b.height) return [];

  const cols = Math.ceil(a.width / CELL);
  const rows = Math.ceil(a.height / CELL);
  const hit = new Uint8Array(cols * rows);

  const differs = (i: number) =>
    Math.abs(a.data[i]! - b.data[i]!) > TOLERANCE ||
    Math.abs(a.data[i + 1]! - b.data[i + 1]!) > TOLERANCE ||
    Math.abs(a.data[i + 2]! - b.data[i + 2]!) > TOLERANCE;

  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (differs((y * a.width + x) * 4)) {
        hit[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
      }
    }
  }

  /*
   * Labelled iteratively rather than by recursive flood fill: a full-width
   * banner is thousands of connected cells and would blow the stack.
   */
  const label = new Int32Array(cols * rows).fill(-1);
  let next = 0;
  for (let c = 0; c < hit.length; c++) {
    if (!hit[c] || label[c] !== -1) continue;
    const id = next++;
    label[c] = id;
    const stack = [c];
    while (stack.length) {
      const cur = stack.pop()!;
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (hit[n] && label[n] === -1) {
            label[n] = id;
            stack.push(n);
          }
        }
      }
    }
  }
  if (next === 0) return [];

  const acc = Array.from({ length: next }, () => ({
    x0: Infinity,
    y0: Infinity,
    x1: -Infinity,
    y1: -Infinity,
  }));
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (!differs((y * a.width + x) * 4)) continue;
      const t = acc[label[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]!]!;
      if (x < t.x0) t.x0 = x;
      if (y < t.y0) t.y0 = y;
      if (x > t.x1) t.x1 = x;
      if (y > t.y1) t.y1 = y;
    }
  }

  return acc
    .map((t) => ({ x: t.x0, y: t.y0, width: t.x1 - t.x0 + 1, height: t.y1 - t.y0 + 1 }))
    .sort((p, q) => q.width * q.height - p.width * p.height);
}

/**
 * `x,y w×h`, the form a reviewer holds against a screenshot.
 *
 * Capped at four. A row listing twenty boxes is not read, and twenty regions
 * is itself the finding — a diff that scattered is not a rename.
 */
export function describeRegions(rs: Region[]): string {
  if (rs.length === 0) return "";
  const shown = rs.slice(0, 4).map((r) => `${r.x},${r.y} ${r.width}×${r.height}`);
  const rest = rs.length - shown.length;
  return ` · ${rs.length} region${rs.length === 1 ? "" : "s"}: ${shown.join(" · ")}${
    rest > 0 ? ` · +${rest} more` : ""
  }`;
}
