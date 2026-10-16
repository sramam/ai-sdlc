import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  type DomBox,
  type MaskBox,
  classifyMotion,
  mergeBoxes,
  refreshDeclared,
  verifyStored,
  snapToDom,
  uncoveredDates,
  writeMaskEvidence,
} from "./boxes.mts";
import { DATE_SHAPES } from "./dom.mts";

/**
 * The snapping rule, exercised directly.
 *
 * `volatileBoxes` needs two PNGs and `domBoxes` needs a browser; the decision
 * that matters is neither of those. It is *which rectangle a differing cluster
 * becomes*, and that is a pure function over boxes — so it is tested here, in
 * the unit suite, rather than inferred from a journey recording.
 *
 * The page is the journeys' own 1280×720, because two of the thresholds are
 * shares of it and a made-up page size would test a cap nothing uses.
 */
const W = 1280;
const H = 720;
/** `PAD_ELEMENT` in `boxes.mts`; a box may sit that far outside its anchor. */
const PAD = 4;

const el = (path: string, x: number, y: number, width: number, height: number): DomBox => ({
  path,
  x,
  y,
  width,
  height,
});

/** The sign-in card, roughly as J31 renders it — see the boxes it produced. */
const card = el("div.rounded-xl.border", 640, 155, 448, 370);
const description = el("p.text-muted-foreground", 683, 219, 362, 60);
const countdown = el("span.font-mono.tabular-nums", 968, 259, 34, 20);
const button = el("button.w-full", 674, 415, 380, 40);

describe("snapToDom", () => {
  it("takes the smallest element containing the cluster, not the card", () => {
    // Two digits of the countdown changed.
    const [box] = snapToDom(
      [{ x: 970, y: 262, width: 16, height: 14 }],
      [card, description, countdown],
      W,
      H,
    );

    expect(box!.from).toBe("span.font-mono.tabular-nums");
    // The span plus padding — not the paragraph, and nothing like the card.
    expect(box!.width).toBeLessThan(description.width);
  });

  it("keeps two distant clusters apart instead of spanning them", () => {
    const boxes = snapToDom(
      [
        { x: 970, y: 262, width: 16, height: 14 }, // the countdown
        { x: 700, y: 425, width: 60, height: 16 }, // the button's label
      ],
      [card, description, countdown, button],
      W,
      H,
    );

    expect(boxes.map((b) => b.from)).toEqual(["span.font-mono.tabular-nums", "button.w-full"]);
    /*
     * The point of the whole change: the union of these two is the card, and
     * the card is what the old NEAR=24 clustering produced. Neither box may
     * reach the other.
     */
    for (const box of boxes) expect(box.width * box.height).toBeLessThan(card.width * card.height);
  });

  it("collapses every cluster inside one element to that element", () => {
    const boxes = snapToDom(
      [
        { x: 700, y: 225, width: 20, height: 12 },
        { x: 800, y: 225, width: 30, height: 12 },
        { x: 900, y: 245, width: 25, height: 12 },
      ],
      [card, description],
      W,
      H,
    );

    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.from).toBe("p.text-muted-foreground");
  });

  it("does not mask the blank half of a block element", () => {
    /*
     * The dashboard's `As of <time>` line. The paragraph is the full content
     * column and the timestamp is a fifth of it, so anchoring to the element
     * masked 3.0% of the page to exclude one clock — and the rest was blank.
     */
    const line = el("p.text-text-secondary.text-sm", 284, 112, 976, 28);
    const [box] = snapToDom([{ x: 288, y: 118, width: 205, height: 15 }], [line], W, H);

    expect(box!.from).toBe("p.text-text-secondary.text-sm");
    expect(box!.width).toBeLessThan(line.width / 2);
    // The line's own height is kept: that is layout-driven and stable.
    expect(box!.height).toBeGreaterThanOrEqual(line.height);
    // …and it never reaches outside the element it is named after.
    expect(box!.x).toBeGreaterThanOrEqual(line.x - PAD);
    expect(box!.x + box!.width).toBeLessThanOrEqual(line.x + line.width + PAD);
  });

  it("still spans an element when its content differs end to end", () => {
    // The clamp is to the anchor, so text filling its line is fully covered.
    const line = el("p.wide", 284, 112, 400, 28);
    const [box] = snapToDom([{ x: 288, y: 118, width: 392, height: 15 }], [line], W, H);

    expect(box!.x).toBeLessThanOrEqual(line.x);
    expect(box!.x + box!.width).toBeGreaterThanOrEqual(line.x + line.width);
  });

  it("refuses an anchor larger than the cap and falls back to the pixels", () => {
    /*
     * Tripping `MAX_ANCHOR_SHARE`. The only element containing this cluster is
     * a page-sized wrapper, and anchoring to it would mask the screen while
     * reporting a mask.
     */
    const wrapper = el("main.min-h-screen", 0, 0, W, H);
    const [box] = snapToDom([{ x: 600, y: 300, width: 20, height: 12 }], [wrapper], W, H);

    expect(box!.from).toBe("pixels");
    expect(box!.width * box!.height).toBeLessThan(W * H * 0.01);
  });

  it("names a cluster no element contains rather than dropping it", () => {
    // A focus ring or a shadow falls outside every rect.
    const [box] = snapToDom([{ x: 20, y: 20, width: 8, height: 8 }], [card], W, H);

    expect(box!.from).toBe("pixels");
  });

  it("covers the pixel or two a glyph overhangs its element by", () => {
    const tight = el("span.tight", 100, 100, 20, 20);
    const [box] = snapToDom([{ x: 99, y: 100, width: 22, height: 20 }], [tight], W, H);

    expect(box!.from).toBe("span.tight");
    // Anchored, and the union still reaches what actually differed.
    expect(box!.x).toBeLessThanOrEqual(99);
    expect(box!.x + box!.width).toBeGreaterThanOrEqual(121);
  });

  it("refuses an element the cluster spills well outside", () => {
    /*
     * A popover, a tooltip or a transformed child starts inside a box and
     * leaves it. Anchoring to the box it happens to overlap would mask a region
     * on the strength of an element that does not contain it — so it does not,
     * and the fallback says as much.
     */
    const tight = el("span.tight", 100, 100, 20, 20);
    const [box] = snapToDom([{ x: 100, y: 100, width: 60, height: 20 }], [tight], W, H);

    expect(box!.from).toBe("pixels");
    expect(box!.x + box!.width).toBeGreaterThanOrEqual(160);
  });

  it("drops an unattributable cluster that covers the page", () => {
    /*
     * A page-sized diff nothing contains means the two runs rendered different
     * screens, not that something very large varies. Storing it is a mask over
     * everything — `happy/04-choose-an-organization` learned exactly that, one
     * box at 100%, and then passed every comparison for ever.
     */
    const boxes = snapToDom([{ x: 0, y: 0, width: W, height: H }], [], W, H);

    expect(boxes).toEqual([]);
  });

  it("still masks a large cluster when an element owns it", () => {
    // The cap is on *unattributable* boxes; an element within the anchor cap is
    // masked normally however much of it differed.
    const boxes = snapToDom([{ x: 674, y: 415, width: 380, height: 40 }], [button], W, H);

    expect(boxes.map((b) => b.from)).toEqual(["button.w-full"]);
  });

  it("clamps to the image rather than reporting a box off the edge", () => {
    const corner = el("div.corner", W - 10, H - 10, 10, 10);
    const [box] = snapToDom([{ x: W - 6, y: H - 6, width: 6, height: 6 }], [corner], W, H);

    expect(box!.x + box!.width).toBeLessThanOrEqual(W);
    expect(box!.y + box!.height).toBeLessThanOrEqual(H);
  });
});

describe("mergeBoxes", () => {
  it("is idempotent, so a second learning pass does not grow the file", () => {
    const once = snapToDom(
      [
        { x: 970, y: 262, width: 16, height: 14 },
        { x: 700, y: 425, width: 60, height: 16 },
      ],
      [card, countdown, button],
      W,
      H,
    );

    /*
     * The mask is a union across passes. Without this, `journey:masks` would
     * append a second copy of every box each time it ran — the file growing for
     * ever while describing exactly the same region.
     */
    expect(mergeBoxes([...once, ...once])).toEqual(once);
  });

  it("drops a box that another already contains", () => {
    const outer = { x: 100, y: 100, width: 200, height: 100, from: "div.outer" };
    const inner = { x: 120, y: 120, width: 20, height: 20, from: "span.inner" };

    expect(mergeBoxes([inner, outer])).toEqual([outer]);
  });

  /*
   * **Two distant elements sharing a path become one box across both** — which
   * is correct for `mergeBoxes` and catastrophic if the path names a *set*.
   *
   * This is the arithmetic behind #651, pinned here so the rule stays visible:
   * merging is keyed on `from`, so the guarantee that a mask cannot cover a
   * neighbour lives entirely in whoever assigns that string.
   * `declaredVolatileBoxes` assigns one per element for this reason.
   */
  it("merges two boxes that name the same element, however far apart", () => {
    const first = { x: 313, y: 253, width: 76, height: 24, from: "declared:[data-clock]" };
    const second = { x: 387, y: 687, width: 76, height: 24, from: "declared:[data-clock]" };

    const [merged, ...rest] = mergeBoxes([first, second]);

    expect(rest).toEqual([]);
    // The bounding box of both — 458 tall, from two 24px stamps.
    expect(merged).toMatchObject({ y: 253, height: 458 });
  });

  it("keeps two clocks apart when each carries its own path", () => {
    const first = { x: 313, y: 253, width: 76, height: 24, from: "declared:dd[data-clock][0]" };
    const second = { x: 387, y: 687, width: 76, height: 24, from: "declared:p[data-clock][1]" };

    expect(mergeBoxes([first, second])).toHaveLength(2);
  });
});

/**
 * Which motion is a clock and which is a page still arriving.
 *
 * Both cases here are real and were measured on 2026-09-03: J31's expiry
 * countdown, which a learned mask caught on three sibling steps and missed on
 * the fourth by luck, and J35's `blank-property/05`, whose problem list settles
 * from two problems to one as the draft saves. Masking the second is how a
 * step named *several things wrong at once* comes to assert nothing.
 */
describe("classifyMotion", () => {
  const box = (path: string, x: number, y: number, w = 50, h = 24): MaskBox => ({
    x,
    y,
    width: w,
    height: h,
    from: path,
  });

  it("masks a value that is still moving when the window closes", () => {
    // The countdown: 09:59 → 09:58 → 09:57, the same span each time.
    const timer = box("span.font-mono.tabular-nums", 939, 278, 51);
    const { ticking, settling } = classifyMotion([timer], [timer]);
    expect(ticking).toHaveLength(1);
    expect(ticking[0]!.from).toBe("span.font-mono.tabular-nums");
    expect(settling).toHaveLength(0);
  });

  it("does not mask state that arrived and then stopped", () => {
    // `Saving… / 2 problems` → `Saved / 1 problem`, then still.
    const problems = box("div.problem-list", 340, 340, 380, 60);
    const { ticking, settling } = classifyMotion([problems], []);
    expect(ticking).toHaveLength(0);
    expect(settling.map((b) => b.from)).toEqual(["div.problem-list"]);
  });

  it("masks a region that only starts moving in the second interval", () => {
    // Still moving at the end of the window, which is the question being asked.
    const late = box("div.poll", 10, 10);
    const { ticking, settling } = classifyMotion([], [late]);
    expect(ticking.map((b) => b.from)).toEqual(["div.poll"]);
    expect(settling).toHaveLength(0);
  });

  it("matches one clock across two observations of different width", () => {
    // 09:59 → 10:00 is one digit wider; equality of rectangles would miss it.
    const before = box("span.timer", 939, 278, 51);
    const after = box("span.timer", 935, 278, 59);
    expect(classifyMotion([before], [after]).ticking).toHaveLength(1);
  });

  it("falls back to overlap when neither box names an element", () => {
    const a = { x: 100, y: 100, width: 40, height: 20, from: "pixels" };
    const near = { x: 120, y: 105, width: 40, height: 20, from: "pixels" };
    const far = { x: 900, y: 600, width: 40, height: 20, from: "pixels" };
    expect(classifyMotion([a], [near]).ticking).toHaveLength(1);
    expect(classifyMotion([a], [far]).settling).toHaveLength(1);
  });

  it("keeps the two apart when a page has both at once", () => {
    const timer = box("span.timer", 939, 278);
    const saving = box("div.saved-indicator", 340, 200);
    const { ticking, settling } = classifyMotion([timer, saving], [timer]);
    expect(ticking.map((b) => b.from)).toEqual(["span.timer"]);
    expect(settling.map((b) => b.from)).toEqual(["div.saved-indicator"]);
  });
});

/**
 * The union must not creep.
 *
 * Learning only ever adds boxes, so the same element learned twice at slightly
 * different rectangles used to keep both — and every future pass could add
 * another. Measured on the sign-in email: one `tbody` at 237,172 and again at
 * 238,172, reported as 2.2% of an image where the truth is half that.
 */
describe("mergeBoxes and the ratchet", () => {
  const at = (from: string, x: number, y: number, w = 199, h = 32): MaskBox => ({
    x,
    y,
    width: w,
    height: h,
    from,
  });

  it("merges two learnings of one element into one box", () => {
    const merged = mergeBoxes([at("tbody", 237, 172), at("tbody", 238, 172)]);
    expect(merged).toHaveLength(1);
    // The span of both, not either one: 237..437 wide.
    expect(merged[0]).toMatchObject({ x: 237, y: 172, width: 200, height: 32 });
  });

  it("does not grow when the same box is learned again", () => {
    const once = mergeBoxes([at("tbody", 237, 172)]);
    const twice = mergeBoxes([...once, at("tbody", 237, 172)]);
    expect(twice).toEqual(once);
  });

  it("keeps distinct elements apart", () => {
    const merged = mergeBoxes([at("tbody", 237, 172), at("span.timer", 900, 400, 50, 20)]);
    expect(merged).toHaveLength(2);
  });

  /*
   * `pixels` means *no element matched*, so two of them are not evidence of one
   * thing — merging them would join unrelated regions across the page, which is
   * the creep this is meant to stop.
   */
  it("never joins two unattributed regions", () => {
    const merged = mergeBoxes([
      { x: 10, y: 10, width: 20, height: 20, from: "pixels" },
      { x: 900, y: 600, width: 20, height: 20, from: "pixels" },
    ]);
    expect(merged).toHaveLength(2);
  });
});

/**
 * **The coverage rule behind the date pattern check.**
 *
 * `dateBoxes` needs a browser and `exercisedBy` needs two PNGs; what decides
 * whether a step is red tomorrow is neither. It is *does the mask cover this
 * run of characters*, which is a pure function over rectangles.
 *
 * The date box is the rectangle of the **matched characters**, not of the
 * element holding them — see `dom-boxes.ts`. So the fixtures below are a
 * `2026-09-08` inside a wider cell, which is the shape every real case takes.
 */
describe("uncoveredDates", () => {
  const date: DomBox = { path: "span.text-text-secondary", x: 100, y: 200, width: 80, height: 16 };
  const box = (x: number, y: number, width: number, height: number): MaskBox => ({
    x,
    y,
    width,
    height,
    from: "declared:span[data-volatile-date][0]",
  });

  it("passes a date the mask contains", () => {
    expect(uncoveredDates([date], [box(90, 195, 100, 30)])).toEqual([]);
  });

  it("passes a mask that fits it exactly", () => {
    expect(uncoveredDates([date], [box(100, 200, 80, 16)])).toEqual([]);
  });

  it("reports a date nothing masks", () => {
    expect(uncoveredDates([date], [])).toEqual([date]);
    expect(uncoveredDates([date], [box(0, 0, 50, 50)])).toEqual([date]);
  });

  /*
   * **The one worth having.** A box over the minutes and not the hour looks
   * masked, passes the run that learned it, and fails later on the digits
   * nobody watched move — the failure the audit trail's `data-volatile-clock`
   * comment records. Reported exactly like no box at all.
   */
  it("reports a date the mask covers only partly", () => {
    expect(uncoveredDates([date], [box(140, 200, 40, 16)])).toEqual([date]);
  });

  /*
   * Two boxes that each cover half and together cover all of it: the check is
   * over the union, because a mask is a set of rectangles rather than one.
   */
  it("accepts two boxes that cover it between them", () => {
    expect(uncoveredDates([date], [box(100, 200, 40, 16), box(140, 200, 40, 16)])).toEqual([]);
  });

  it("judges each date on its own", () => {
    const other: DomBox = { ...date, y: 300 };
    expect(uncoveredDates([date, other], [box(100, 200, 80, 16)])).toEqual([other]);
  });
});

/**
 * **The geometry a declared box is compared with** (#773).
 *
 * The real fault is a date one character wider than the day its mask was
 * learned on, and the numbers below are the measured ones: `J40 happy/01`'s
 * `Since` cell was `1026×83` on 2026-09-09 holding *"Sep 9, 2026"* and
 * `1018×92` on the 11th holding *"Sep 11, 2026"*. Nine pixels of digit outside
 * the box, six of seven paths red, and nothing reporting it for two days.
 *
 * Every case here is the guard being **tripped** rather than read: the first
 * test fails against the old behaviour, and the two refusals below are the
 * branches a naive "just use today's rectangle" would get wrong.
 */
describe("refreshDeclared", () => {
  const declared = (x: number, width: number, extra: Partial<MaskBox> = {}): MaskBox => ({
    x,
    y: 293,
    width,
    height: 17,
    from: "declared:span[data-volatile-date][0]",
    provenance: "declared",
    ...extra,
  });
  const live = (x: number, width: number): DomBox => ({
    x,
    y: 293,
    width,
    height: 17,
    path: "declared:span[data-volatile-date][0]",
  });

  it("widens a box to hold the value rendered today", () => {
    // 1026–1109 learned, 1018–1110 today: the union is 1018–1110.
    expect(refreshDeclared([declared(1026, 83)], [live(1018, 92)])).toEqual([declared(1018, 92)]);
  });

  /*
   * **The direction that is easy to forget.** Both images are masked with the
   * same boxes, so a box shrunk to today's narrower date leaves the baseline's
   * wider one showing and a *narrowing* date reads as a regression.
   */
  it("keeps the wider stored box when today's value is narrower", () => {
    expect(refreshDeclared([declared(1018, 92)], [live(1026, 83)])).toEqual([declared(1018, 92)]);
  });

  /*
   * A row shifted, or a column was inserted above. Stretching the box across
   * the gap would swallow whatever now lies between the element and where it
   * used to be, so the stored box stands and `uncoveredDates` goes red — which
   * is a person re-learning a mask rather than a mask quietly growing.
   */
  it("refuses to stretch to an element that has moved away", () => {
    const moved: DomBox = { ...live(1018, 92), y: 700 };
    expect(refreshDeclared([declared(1026, 83)], [moved])).toEqual([declared(1026, 83)]);
  });

  /*
   * A date somebody added since the mask was learned. Masking it on sight would
   * hide the product change that brought it; a mask may only grow through a
   * relearn.
   */
  it("does not adopt a declared element the mask has never held", () => {
    const fresh: DomBox = { ...live(400, 60), path: "declared:span[data-volatile-date][3]" };
    expect(refreshDeclared([declared(1026, 83)], [fresh])).toEqual([declared(1026, 83)]);
  });

  /* The element is gone from this page. A box over where it was excludes
   * nothing, and deleting it here would edit a mask on a run that may not
   * learn. */
  it("leaves a box whose element is absent", () => {
    expect(refreshDeclared([declared(1026, 83)], [])).toEqual([declared(1026, 83)]);
  });

  /* Learned boxes are the residue of two runs that already happened. There is
   * no selector to re-ask, and re-resolving one would be a category error. */
  it("does not touch a learned box", () => {
    const learned: MaskBox = {
      x: 1026,
      y: 293,
      width: 83,
      height: 17,
      from: "span.tabular-nums",
      provenance: "learned",
    };
    expect(refreshDeclared([learned], [{ ...live(1018, 92), path: "span.tabular-nums" }])).toEqual([
      learned,
    ]);
  });

  /* `exercised` is evidence a box has done real work, and losing it on a
   * widening would quietly reset the box to unexercised. */
  it("carries the evidence across", () => {
    expect(
      refreshDeclared([declared(1026, 83, { exercised: "2026-09-10" })], [live(1018, 92)]),
    ).toEqual([declared(1018, 92, { exercised: "2026-09-10" })]);
  });
});

/**
 * **The shapes were unreachable until they moved out of the closure.**
 *
 * `dateBoxes` built its patterns inside `page.evaluate`, so nothing could ask
 * what they matched — and what they did not match was the one date format this
 * product prints most: `2026-09`, the period key. Six month chips on the
 * owner's statements page are computed from `new Date()`, none was masked, and
 * J7 would have gone red on the 1st.
 *
 * A regex nobody can test is a regex nobody has read.
 */
describe("DATE_SHAPES", () => {
  const matches = (text: string) => DATE_SHAPES.some((source) => new RegExp(source).test(text));

  it("matches every date format the product prints", () => {
    for (const text of [
      "2026-09-08", // ISO, on the audit trail
      "14:03", // a countdown
      "Sep 8, 2026", // toLocaleDateString("en-US", { month: "short" })
      "2026-09", // the period key — charges, statements, every statement URL
      "Statement for 2026-09 — your share is 33.33%", // and inside a sentence
    ]) {
      expect(matches(text), text).toBe(true);
    }
  });

  it("leaves alone the numbers that only look like dates", () => {
    for (const text of ["1 of 25", "$4,093.00", "33.33%", "Page 1 of 2", "90210"]) {
      expect(matches(text), text).toBe(false);
    }
  });

  /**
   * The period shape must not take the front off a full date and leave a box
   * that stops one character short of the day — the ISO shape covers that case
   * whole, and two overlapping boxes of different widths is how a mask starts
   * failing on the edge of a glyph.
   */
  it("does not cut a full date in half", () => {
    const period = new RegExp(DATE_SHAPES[3]!, "g");
    expect("2026-09-13".match(period)).toBeNull();
    expect("2026-09".match(period)).toEqual(["2026-09"]);
  });
});

/**
 * **The union is only sound while a path still means what it meant** (#718's
 * second half).
 *
 * These are written against the real case rather than an invented one: J23
 * `assign-and-resolve/03-start-work` has two clocks 434px apart, both plain
 * `span`, and a sidebar that gained a destination between two learning runs.
 */
describe("verifyStored", () => {
  const dom = (path: string, x: number, y: number): DomBox => ({
    x,
    y,
    width: 116,
    height: 15,
    path,
  });
  const mask = (from: string, x: number, y: number): MaskBox => ({
    x,
    y,
    width: 116,
    height: 15,
    from,
    provenance: "learned",
  });

  it("keeps a box whose path still lands on it", () => {
    const { kept, dropped } = verifyStored(
      [mask("span[17]", 623, 281)],
      [dom("span[17]", 623, 281)],
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  /**
   * The one that produced a 376×457 mask. A destination added to the sidebar
   * shifts every later `span[n]` by one, so the stored `span[17]` — learned at
   * the top clock — now resolves to its neighbour 434px away. Merging them is
   * what covered the Update card and all three of its buttons.
   */
  it("drops a box whose path now lands somewhere else", () => {
    const { kept, dropped } = verifyStored(
      [mask("span[17]", 623, 281)],
      [dom("span[17]", 313, 715)],
    );
    expect(kept).toHaveLength(0);
    expect(dropped.map((b) => b.from)).toEqual(["span[17]"]);
  });

  it("drops a box whose path is not on this page at all", () => {
    const { kept, dropped } = verifyStored([mask("span[17]", 623, 281)], [dom("span[3]", 10, 10)]);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  /**
   * `pixels` means *no element matched*, so there is no claim about an element
   * to re-check — the same exemption `mergeBoxes` makes, for the same reason.
   */
  it("keeps an unattributed box, which makes no claim to verify", () => {
    const loose: MaskBox = {
      x: 10,
      y: 10,
      width: 8,
      height: 8,
      from: "pixels",
      provenance: "learned",
    };
    expect(verifyStored([loose], []).kept).toEqual([loose]);
  });

  /**
   * **A declared box is findable only in the declared enumeration** (#874).
   *
   * The two enumerations index independently, so one element is `div.flex[3]`
   * to `domBoxes` and `declared:div[data-volatile-code][0]` to
   * `declaredVolatileBoxes` — and a stored declared box carries the second
   * spelling. Handed the DOM list alone the lookup misses every time, so every
   * declared box was dropped on **every** run.
   *
   * It cost no correctness: `journey.ts` re-adds declared boxes from the live
   * page in the same breath. It cost the *warning*, which fired on every run of
   * every journey and buried the stale learned box it exists to report — a
   * check whose normal output is noise, which is the same defect as one whose
   * normal output is silence.
   *
   * Asserted from both sides, because passing only the first list is exactly
   * how the bug is reintroduced.
   */
  /**
   * **The call site, not the function.** The test below pins what
   * `verifyStored` does with the list it is handed, and the defect was *which
   * list it was handed* — so that test passes against the broken code and
   * proves nothing about it. Reading the source is crude and is the only thing
   * here that can fail when somebody narrows the argument back.
   */
  /*
   * An earlier version read `journey.ts` here and asserted `verifyStored(carried, …)` is
   * handed both `dom` and `declared`. The recorder arrives in step 3; until it
   * does there is no call site to read, and a test passing against nothing is
   * the failure this one exists to prevent.
   */
  it.todo(
    "is called with both enumerations, since a declared path is in only one (recorder, step 3)",
  );

  it("finds a declared box when given the enumeration that names it", () => {
    const stored: MaskBox = {
      x: 736,
      y: 354,
      width: 256,
      height: 36,
      from: "declared:div[data-volatile-code][0]",
      provenance: "declared",
    };
    const live = dom("declared:div[data-volatile-code][0]", 736, 354);

    expect(verifyStored([stored], [dom("div.flex[3]", 736, 354)]).dropped).toHaveLength(1);
    expect(verifyStored([stored], [dom("div.flex[3]", 736, 354), live]).kept).toEqual([stored]);
  });

  /**
   * **Proved by tripping it.** Without the verification the two boxes merge,
   * because `mergeBoxes` joins by `from` alone — this is the exact arithmetic
   * that produced 15.8% of a page, asserted so a future change that removes
   * the check fails here rather than in a recording six weeks later.
   */
  it("is what stops mergeBoxes spanning two unrelated regions", () => {
    const stale = mask("span[17]", 623, 281);
    const live = mask("span[17]", 313, 715);

    const unchecked = mergeBoxes([stale, live]);
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]!.width * unchecked[0]!.height).toBeGreaterThan(100_000);

    const { kept } = verifyStored([stale], [dom("span[17]", 313, 715)]);
    const checked = mergeBoxes([...kept, live]);
    expect(checked).toHaveLength(1);
    expect(checked[0]!.width * checked[0]!.height).toBeLessThan(2_000);
  });
});

/**
 * **Proved by tripping it**, because the whole value of this is that the files
 * exist and differ — a writer that silently produced three identical images
 * would look exactly like a working one from the failure message that names it.
 */
describe("writeMaskEvidence", () => {
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

  it("keeps both passes and paints only what differed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-evidence-"));
    const before = join(dir, "before.png");
    const after = join(dir, "after.png");
    writeFileSync(
      before,
      png(20, 10, () => [0, 0, 0]),
    );
    writeFileSync(
      after,
      png(20, 10, (x, y) => (x === 3 && y === 4 ? [255, 255, 255] : [0, 0, 0])),
    );

    const out = writeMaskEvidence(before, after, join(dir, "out"))!;

    // Kept verbatim, which is what makes them evidence rather than a rendering.
    expect(readFileSync(join(out, "1-before.png"))).toEqual(readFileSync(before));
    expect(readFileSync(join(out, "2-after.png"))).toEqual(readFileSync(after));

    const diff = PNG.sync.read(readFileSync(join(out, "3-diff.png")));
    const lit = (x: number, y: number) => diff.data[(y * diff.width + x) * 4] !== 0;
    expect(lit(3, 4)).toBe(true);
    expect(lit(0, 0)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A resize cannot be diffed at all — `differing` returns null — and the two
   * copies are still the useful half. A black rectangle instead would read as
   * "nothing differed", which is the opposite of what happened.
   */
  it("keeps both passes and writes no diff when the page resized", () => {
    const dir = mkdtempSync(join(tmpdir(), "mask-evidence-"));
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

    const out = writeMaskEvidence(before, after, join(dir, "out"))!;
    expect(existsSync(join(out, "1-before.png"))).toBe(true);
    expect(existsSync(join(out, "2-after.png"))).toBe(true);
    expect(existsSync(join(out, "3-diff.png"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
