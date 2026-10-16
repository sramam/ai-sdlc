import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { boxOf } from "./dom.mts";

/**
 * **The rounding `dom.mts` performs** (#923).
 *
 * It used to be three copies, because every probe runs inside a
 * `page.evaluate` that cannot close over an import — so this suite asserted
 * the arithmetic against measured numbers and then asserted, from the source,
 * that each copy still spelled it the same way. Neither half was worth much
 * alone: the first proved a formula nobody had to use, the second a spelling.
 *
 * **The probes now return the four floats and `boxOf` rounds them here**, so
 * the first half exercises the real function and the second asks a much
 * smaller question — *is `boxOf` still the only thing making a box*.
 */
const outward = (start: number, extent: number) => ({
  from: Math.floor(start),
  to: Math.ceil(start + extent),
});

/** What all three probes used to do: floor the origin, ceil the *extent*. */
const byExtent = (start: number, extent: number) => ({
  from: Math.floor(start),
  to: Math.floor(start) + Math.ceil(extent),
});

describe("rounding a rect to the pixels it paints", () => {
  /**
   * J43 `happy/01`, measured. A `data-volatile-clock` and the clock text
   * inside it share a right edge at 1084.4, and the two probes rounded it
   * independently — so the element stopped at 1084 and the text it declares
   * reached 1085.
   */
  const element = { left: 949.5, width: 134.9 };
  const text = { left: 1044.2, width: 40.2 };

  it("reproduces the one-pixel gap the old form left", () => {
    expect(byExtent(element.left, element.width)).toEqual({ from: 949, to: 1084 });
    expect(byExtent(text.left, text.width)).toEqual({ from: 1044, to: 1085 });
  });

  it("covers the text with its own declaring element", () => {
    const box = outward(element.left, element.width);
    const inside = outward(text.left, text.width);
    expect(box.from).toBeLessThanOrEqual(inside.from);
    expect(box.to).toBeGreaterThanOrEqual(inside.to);
  });

  /**
   * The property the fix rests on, rather than the one case that found it:
   * `floor(L) + ceil(W)` is never *more* than `ceil(L + W)`, so the old form
   * could only ever lose coverage — and it does lose it, which is what makes
   * this a fix rather than a tidy-up.
   */
  it("never over-covers, and sometimes under-covers", () => {
    let short = 0;
    for (let l = 0; l < 40; l++) {
      for (let w = 1; w < 40; w++) {
        const start = l + l / 40;
        const extent = w + w / 40;
        const right = outward(start, extent).to;
        const old = byExtent(start, extent).to;
        expect(old).toBeLessThanOrEqual(right);
        if (old < right) short++;
      }
    }
    expect(short).toBeGreaterThan(0);
  });

  /**
   * **Containment, for any nesting** — which is the claim the declared-volatile
   * scheme actually needs. A range inside an element has a `floor` no smaller
   * and a `ceil` no larger, so the element's box contains it by construction.
   */
  it("contains any range that lies inside the element", () => {
    for (let i = 0; i < 60; i++) {
      const left = 100 + i / 7;
      const width = 50 + i / 3;
      const box = outward(left, width);
      const inner = outward(left + i / 11, width - i / 5);
      expect(box.from).toBeLessThanOrEqual(inner.from);
      expect(box.to).toBeGreaterThanOrEqual(inner.to);
    }
  });
});

/**
 * **The probes still round outward** — the half that goes red on a regression.
 *
 * Read from the source because the expressions live inside `page.evaluate`
 * bodies and nothing can call them from here. Three sites, and the count is
 * asserted so that a fourth probe added later has to be looked at rather than
 * silently exempted.
 */
describe("boxOf is the only thing that makes a box", () => {
  const source = readFileSync(new URL("./dom.mts", import.meta.url), "utf8");

  /**
   * **The property the masks actually depend on**, over random rects rather
   * than over the cases somebody thought of.
   *
   * `mask.ts` iterates `x < box.x + box.width`, a half-open interval, so the
   * far edge is exclusive and `x + width >= right` is the claim — not `>`.
   *
   * This is what three sessions established by sampling before anybody wrote
   * it down: dc measured the DOM probes at ~50% losing an edge, ea measured
   * the PDF one at ~87%, and both were reproduced. A fact re-derived by
   * sampling is a fact nobody has encoded.
   */
  it("contains the interval it was given, for any rect", () => {
    /*
     * **Seeded, not random**, and the volatility pattern check is right to insist:
     * anything under `e2e/` that varies between runs makes a recording
     * non-deterministic. A property test is the one place randomness earns
     * its place, and a *seeded* one is strictly better than an exemption —
     * a failure names the same rects every run, so it can be reproduced
     * rather than chased. Same argument as the fixed faker seed in
     * `packages/db`.
     */
    let seed = 0x9e3779b9;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    const bad: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const left = next() * 2000;
      const top = next() * 2000;
      const right = left + next() * 300;
      const bottom = top + next() * 300;
      const b = boxOf(left, top, right, bottom);
      if (b.x > left || b.x + b.width < right || b.y > top || b.y + b.height < bottom) {
        bad.push(`[${left},${right}) x [${top},${bottom}) -> ${JSON.stringify(b)}`);
      }
    }
    expect(bad.slice(0, 3), `${bad.length} of 20000 rects were not contained`).toEqual([]);
  });

  /** Integer rects must not be widened — outward rounding is not padding. */
  it("does not grow a rect that is already whole", () => {
    expect(boxOf(10, 20, 30, 50)).toEqual({ x: 10, y: 20, width: 20, height: 30 });
  });

  /**
   * **The narrow claim, which is the one that survives a refactor.** Asserting
   * a spelling in three copies is what this replaced; asserting that only one
   * function rounds is true by construction and catches a new probe by
   * *existing* rather than by somebody remembering to look.
   *
   * **Scoped to the whole of `src/` and not to this file, which is how the fourth
   * spelling was missed.** `pdf-pages.ts` rounded a PDF glyph's rect with
   * `round(left)` and `round(width)` — the worst of the four forms, losing an
   * edge in 87.5% of rects — and a pattern check reading one file could not see it,
   * because it is not a DOM probe and nobody auditing the three would have
   * opened it. *A pattern check naming one shape goes silent outside it* is a failure
   * this repository has now paid for twice: in a list-pane check and here.
   *
   * Declared exemptions rather than a narrower scan: each is an **exact
   * expression** with a reason that is a property of what it computes, so a new
   * `Math.floor` anywhere under `src/` has to be looked at, and an
   * entry that stops matching fails too.
   */
  it("holds every floor and ceil under src/", () => {
    /**
     * Not a box — none of these is an interval with two edges to round.
     *
     * An earlier list named a canvas buffer, a duration and a name table. The
     * canvas buffer arrived with `render/pdf.mts`; the duration here uses
     * `Math.trunc` instead. The grid arithmetic in `regions.mts`
     * is new here only because the earlier pattern check scanned `e2e/support/` and
     * `regions` lived in `scripts/`: it was never asked.
     */
    const NOT_A_BOX = new Map([
      ["Math.ceil(a.width / CELL)", "how many 8px grid cells span the image — a count"],
      ["Math.ceil(a.height / CELL)", "the same count, its other dimension"],
      ["Math.floor(y / CELL)", "the grid row a pixel falls in — an index, not an edge"],
      ["Math.floor(x / CELL)", "the grid column a pixel falls in — an index, not an edge"],
      ["Math.floor(cur / cols)", "the row of a cell index"],
      [
        "Math.ceil(viewport.width)",
        "a PDF page's canvas buffer in whole pixels — a size to allocate, not an edge to contain",
      ],
      ["Math.ceil(viewport.height)", "the same buffer, its other dimension"],
    ]);

    const root = new URL("../", import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? e.name === "__fixtures__"
            ? []
            : walk(join(dir, e.name))
          : e.name.endsWith(".mts")
            ? [join(dir, e.name)]
            : [],
      );
    const modules = walk(root).sort();

    const unaccounted: string[] = [];
    const unused = new Set(NOT_A_BOX.keys());
    for (const path of modules) {
      const file = relative(root, path);
      let text = readFileSync(path, "utf8");
      if (file === join("mask", "dom.mts")) {
        // `boxOf` itself is the one place rounding belongs.
        text = text
          .slice(text.indexOf("export function boxOf") + 1)
          .split("\n}")
          .slice(1)
          .join("\n}");
      }
      for (const hit of text.match(/Math\.(floor|ceil)\([^)]*\)/g) ?? []) {
        if (NOT_A_BOX.has(hit)) unused.delete(hit);
        else unaccounted.push(`${file}: ${hit}`);
      }
    }

    expect(unaccounted, "rounding outside boxOf that nothing accounts for").toEqual([]);
    expect([...unused], "declared exemptions that no longer match anything").toEqual([]);
    expect(modules.length).toBeGreaterThan(5);
  });

  /**
   * **Two `Math.round` calls stay, and a pattern check that flagged them would be
   * fixed by deleting them.** Neither is a box: one is a geometry fingerprint
   * and one collects rendered widths into a `Set`, and in both the rounding is
   * a deliberate **tolerance**. Strip it and `geometry()` reports every
   * sub-pixel difference as a reflow, and `widths.size <= 1` stops holding —
   * so every declared element comes back width-varying.
   *
   * Asserted rather than merely not-asserted, so the next person tightening
   * this file has to read why before removing them.
   */
  it("leaves the two comparison tolerances alone", () => {
    expect(source.match(/Math\.round\(/g) ?? []).toHaveLength(4);
  });
});
