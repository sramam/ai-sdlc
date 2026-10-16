import { PNG } from "pngjs";

/**
 * **Two renderings of one layout, and where they differ** (#963).
 *
 * A statement is read by somebody who read last month's, so what matters is
 * not whether this month's figures are right — unit tests answer that — but
 * whether the document still puts things where they were. A column that moves,
 * a logo that is replaced, a row that disappears: none of those is a wrong
 * number, and all of them cost the reader the thing the document is for.
 *
 * ## Why a picture rather than a text diff
 *
 * Text is the better *gate* — it can name the label that changed, and
 * `pdfText` is what the reconciliation step already reads. It is a poor
 * *report*: extracted text carries no logo, no rule, no spacing and no font,
 * so the whole class of change a reader would notice first is invisible to it.
 *
 * So this is the half a person looks at. Red where the two months differ,
 * nothing where they agree — a reviewer glances and sees whether the red is
 * confined to the period heading and the figure columns, which is what drift
 * looks like when there is none.
 *
 * ## Side by side, with the difference tinted onto the later month
 *
 * Three images stacked would make a reader hold two of them in their head to
 * use the third. Here the pages sit beside each other and the *right* one
 * carries the tint, so the answer to "where did it move" is read off the same
 * picture that shows what moved to.
 *
 * **A size change is a finding, not an error.** Two statements whose pages are
 * different sizes have already drifted — a page that grew is `#902`'s class —
 * so the pair is still drawn, and the mismatch is reported rather than thrown.
 */
export type PageDiff = {
  /** The side-by-side PNG, tinted where the two differ. */
  png: Buffer;
  /** Pixels that differ, and as a fraction of the page. */
  pixels: number;
  ratio: number;
  /** Set when the two pages are not the same size, which is itself drift. */
  resized?: { was: string; now: string };
};

const GAP = 24;

export function pageDiff(before: Uint8Array, after: Uint8Array): PageDiff {
  const a = PNG.sync.read(Buffer.from(before));
  const b = PNG.sync.read(Buffer.from(after));

  const resized =
    a.width === b.width && a.height === b.height
      ? undefined
      : { was: `${a.width}x${a.height}`, now: `${b.width}x${b.height}` };

  const width = a.width + GAP + b.width;
  const height = Math.max(a.height, b.height);
  const out = new PNG({ width, height });
  // Mid grey, so a page shorter than its neighbour ends visibly rather than
  // trailing off into white that reads as blank paper.
  out.data.fill(0x88);

  const blit = (src: PNG, dx: number) => {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const from = (y * src.width + x) * 4;
        const to = (y * width + (x + dx)) * 4;
        out.data[to] = src.data[from]!;
        out.data[to + 1] = src.data[from + 1]!;
        out.data[to + 2] = src.data[from + 2]!;
        out.data[to + 3] = 255;
      }
    }
  };
  blit(a, 0);
  blit(b, a.width + GAP);

  /*
   * Compared only where both pages have a pixel. Outside that the two cannot
   * be said to differ — there is nothing to compare against — and counting it
   * would make every size change read as a total rewrite, drowning the thing
   * the picture is for.
   */
  let pixels = 0;
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      if (
        a.data[ia] !== b.data[ib] ||
        a.data[ia + 1] !== b.data[ib + 1] ||
        a.data[ia + 2] !== b.data[ib + 2]
      ) {
        pixels++;
        // Tinted rather than replaced: the glyph underneath stays readable, so
        // a reviewer can tell "September, not August" from "the logo is gone".
        const to = (y * width + (x + a.width + GAP)) * 4;
        out.data[to] = 255;
        out.data[to + 1] = Math.round(out.data[to + 1]! * 0.25);
        out.data[to + 2] = Math.round(out.data[to + 2]! * 0.25);
      }
    }
  }

  return {
    png: PNG.sync.write(out),
    pixels,
    ratio: w * h === 0 ? 0 : pixels / (w * h),
    ...(resized ? { resized } : {}),
  };
}
