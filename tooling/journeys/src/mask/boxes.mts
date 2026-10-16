import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

/**
 * **Turning "recorded, not compared" into a gate.**
 *
 * Almost every journey step was recorded and guarded by nothing, because almost
 * every screen here carries something that changes run to run — a sign-in code,
 * an organization slug, a countdown, "as of 14:32". `toHaveScreenshot` on those
 * is red every run, and a gate that fails always is one people pass with
 * `--update-snapshots` without looking, which is worse than no gate.
 *
 * The way out is to find the volatile regions **empirically**: run the same
 * code twice and diff the two screenshots. Anything that differs between two
 * runs of unchanged software is, by construction, not something a change to the
 * software caused. Mask those, compare everything else, and the remaining
 * signal is real.
 *
 * ## Boxes, not pixels
 *
 * A per-pixel mask would be exact and useless: a code rendered one pixel
 * narrower next time falls outside it and reads as a regression. Differing
 * pixels are grouped into **bounding boxes** and each is padded, so the mask
 * covers the region a volatile thing lives in rather than the shape it happened
 * to have. It is deliberately generous — a mask that is too tight produces
 * false alarms, and a false alarm is what teaches somebody to stop reading.
 */

export type Box = { x: number; y: number; width: number; height: number };

/**
 * A box with the element it came from, so a reviewer can judge it by name — and
 * with **where it came from and whether it has ever done any work.**
 *
 * The mask is *found, not declared*, and the two entries in `DECLARED_VOLATILE`
 * are exceptions to that rule taken because the learner cannot see a value
 * moving once a minute or once a day. The objection to declaring is that
 * nothing then proves the box is needed: you cannot observe a run that *would*
 * have failed but did not.
 *
 * You can, by comparing twice — see `exercisedBy`. Three states follow, and the
 * third is the useful one:
 *
 * | | |
 * | --- | --- |
 * | **learned** | the learner found it independently. Corroborated |
 * | **exercised** | this box absorbed a real difference on some run |
 * | **unexercised** | neither. Either the value does not vary, or its period is longer than this recording has lived |
 *
 * A declared date box is *expected* to sit unexercised on the day it is
 * recorded and to become exercised the next morning, which is what makes the
 * third state readable rather than alarming.
 *
 * **The counter is only trustworthy because a declared box resolves from a
 * selector rather than a stored rectangle.** It is exactly one element and
 * cannot creep onto a neighbour, so "this box absorbed a difference" cannot
 * quietly mean "this box swallowed a regression next door". Relaxing that
 * would poison the evidence silently rather than break anything visibly.
 */
export type MaskBox = Box & {
  from: string;
  /** `declared` came from `DECLARED_VOLATILE`; everything else was learned. */
  provenance?: "declared" | "learned";
  /** The date it last absorbed a real difference, `YYYY-MM-DD`. */
  exercised?: string;
};

/** Where an element was when the screenshot was taken — see `dom.mts`. */
export type DomBox = Box & { path: string };

/**
 * **The rule that produced the stored boxes.**
 *
 * A mask is a union across learning passes, which is right while the rule is
 * the same and wrong the moment it changes: unioning boxes learned by two
 * different rules gives you the looser of the two, for ever, and the tighter
 * rule can never take effect. So a stored mask from an older version is
 * **discarded** when learning rather than added to.
 *
 * 1 → pixel bounding boxes alone. 2 → snapped to the DOM. 3 → each box carries
 * its provenance and whether it has ever absorbed a difference.
 */
export const MASK_VERSION = 3;

/**
 * How far a differing pixel may be from a box and still join it.
 *
 * **This was 24, and that is what made the masks card-sized.** 24px reaches
 * across the gap between one widget and the next, so a countdown, six code
 * boxes and a button chained into a single rectangle covering half the sign-in
 * card — 25.7% of the page on `too-many-attempts`, with the heading, the
 * button and every border inside it and therefore compared against nothing.
 *
 * 6px joins the stems of a letter and the letters of a word, and reaches
 * nothing on the next line. Separate things stay separate, and `snapToDom`
 * then grows each one to the element it belongs to — which is the *right*
 * amount of growth, rather than however far the neighbours happened to be.
 */
const CLUSTER_NEAR = 6;
/**
 * Padding on a box that is anchored to an element.
 *
 * The mask is learned on one machine and committed, so it carries that
 * machine's layout. 4px absorbs the sub-pixel differences between there and
 * CI — font hinting, a rounded rect — and nothing larger. A difference big
 * enough to reflow a line moves everything and is a real change, which the
 * comparison should report rather than swallow.
 */
const PAD_ELEMENT = 4;
/**
 * Padding on a box that is **not** anchored to an element — see `snapToDom`.
 *
 * Wider, because there is nothing underneath it saying how big the varying
 * thing can get. The extra slack is the price of not knowing.
 */
const PAD_PIXELS = 8;
/** A glyph may spill a pixel or two past its element; still that element's. */
const CONTAIN_SLACK = 2;
/**
 * How far past the differing content a **block** anchor's mask may reach
 * sideways.
 *
 * An inline element hugs its text, so its box *is* the content and there is
 * nothing to trim. A block does not: `p.text-text-secondary.text-sm` on the
 * dashboard is 976px wide because that is the column, while the text inside it
 * — `As of 2026-09-02 18:27 UTC` — is about two hundred. Masking the element
 * hid 3.0% of the page to exclude one timestamp, and the other 776px were
 * blank.
 *
 * So the **vertical** extent comes from the element, where it is layout-driven
 * and stable, and the **horizontal** extent from what actually differed, plus
 * this. It is never allowed outside the element, so text growing to fill its
 * line is still covered.
 *
 * 32px is roughly three characters at this size — enough for a countdown going
 * from `9:59` to `10:00`. Beyond that the union across learning passes widens
 * it, and the third pass is what catches a mask left too tight.
 */
const INLINE_SLACK = 32;
/**
 * The largest share of the page an element may cover and still be used as an
 * anchor.
 *
 * **A mask exists to exclude a value, not a screen.** Above this an element is
 * a container — a card, a form, a page section — and anchoring to one hides
 * every border, heading and button inside it while reporting success. When the
 * only elements containing a diff are that big, the padded pixel box is the
 * smaller and more honest answer, even though it is unattributed.
 */
const MAX_ANCHOR_SHARE = 0.06;
/** Below this, a lone differing pixel is antialiasing rather than content. */
const MIN_AREA = 4;

/**
 * The most of one screenshot a mask may hide before `journey:masks` refuses.
 *
 * `MAX_ANCHOR_SHARE` bounds a single box; this bounds the whole mask, and the
 * two fail differently — a step can reach a third of the page in twenty
 * blameless little boxes without any one of them being wrong. That is still a
 * screen nobody is comparing, and it wants a person to look rather than a
 * constant to be raised.
 *
 * A **ratchet, not a target**: set above today's worst so a build fails on a
 * regression rather than on the backlog. Raising it needs a written reason
 * here, in the same commit — the rule the coverage floors already carry.
 *
 * **3%, and every journey has earned it.** J31, J33 and J35 are all on this
 * rule now, and the worst step across all 63 is 1.5%. It was 10% while J35's
 * masks were still the older rule's and could not be relearned without
 * colliding with another branch; that branch is merged, so the headroom has no
 * reason left.
 *
 * Lowering it is the goal and raising it needs a written reason here, in the
 * same commit — the rule the coverage floors carry.
 */
export const MAX_STEP_COVERAGE = 0.03;

/**
 * **One declared box may not swallow a card.**
 *
 * A `data-volatile-date` on a row rather than on the date inside it would mask
 * a whole line and pass every comparison for ever — the same failure
 * `MAX_STEP_COVERAGE` catches, arriving through the door marked *deliberate*.
 * A date cell is ~0.1% of a page; 1% is ten times that and still far short of
 * a card.
 *
 * Here rather than in `journey-masks.mts` because the recorder needs it too:
 * a step that trips either threshold keeps its evidence (`writeMaskEvidence`),
 * and the run that can see the two passes is the one that took them.
 */
export const MAX_DECLARED_BOX = 0.01;

const read = (file: string) => PNG.sync.read(readFileSync(file));

/** Every pixel that differs, as a bitmap the size of the image. */
function differing(a: PNG, b: PNG): { diff: Uint8Array; width: number; height: number } | null {
  // Screenshots of different sizes cannot be compared pixel-wise at all — that
  // is a layout change, and the caller reports it as one.
  if (a.width !== b.width || a.height !== b.height) return null;

  const out = new PNG({ width: a.width, height: a.height });
  /*
   * **`diffMask` is not optional here, and leaving it out cost a whole
   * afternoon's mask.** Without it pixelmatch draws the *original* image into
   * the output, dimmed, and only paints the differing pixels red — so every
   * pixel comes back with non-zero alpha and "did this differ" reads yes
   * everywhere. Measured: 182 pixels actually differed and the mask it produced
   * was 1280×720, the entire page, which passes every future comparison and
   * reports success for ever.
   *
   * With it, unchanged pixels are transparent and the alpha test means what it
   * says.
   */
  pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0.1, diffMask: true });

  const diff = new Uint8Array(a.width * a.height);
  for (let i = 0; i < diff.length; i++) {
    diff[i] = out.data[i * 4 + 3] === 0 ? 0 : 1;
  }
  return { diff, width: a.width, height: a.height };
}

/**
 * Differing pixels, grouped into rectangles.
 *
 * A scan rather than a flood fill: rows of differing pixels are merged into the
 * first box they are near, and boxes that end up overlapping are merged again.
 * Exactness is not the point — see the note above.
 */
function boxesOf(diff: Uint8Array, width: number, height: number): Box[] {
  const boxes: Box[] = [];

  for (let y = 0; y < height; y++) {
    let runStart = -1;
    for (let x = 0; x <= width; x++) {
      const on = x < width && diff[y * width + x] === 1;
      if (on && runStart < 0) runStart = x;
      if (on || runStart < 0) continue;

      const run = { x: runStart, y, width: x - runStart, height: 1 };
      runStart = -1;

      const near = boxes.find(
        (b) =>
          run.x <= b.x + b.width + CLUSTER_NEAR &&
          b.x <= run.x + run.width + CLUSTER_NEAR &&
          run.y <= b.y + b.height + CLUSTER_NEAR &&
          b.y <= run.y + run.height + CLUSTER_NEAR,
      );
      if (near) {
        const right = Math.max(near.x + near.width, run.x + run.width);
        const bottom = Math.max(near.y + near.height, run.y + run.height);
        near.x = Math.min(near.x, run.x);
        near.y = Math.min(near.y, run.y);
        near.width = right - near.x;
        near.height = bottom - near.y;
      } else {
        boxes.push(run);
      }
    }
  }

  // Overlaps happen because a box grows after an earlier one was placed.
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length && !merged; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (
          a.x <= b.x + b.width + CLUSTER_NEAR &&
          b.x <= a.x + a.width + CLUSTER_NEAR &&
          a.y <= b.y + b.height + CLUSTER_NEAR &&
          b.y <= a.y + a.height + CLUSTER_NEAR
        ) {
          const right = Math.max(a.x + a.width, b.x + b.width);
          const bottom = Math.max(a.y + a.height, b.y + b.height);
          a.x = Math.min(a.x, b.x);
          a.y = Math.min(a.y, b.y);
          a.width = right - a.x;
          a.height = bottom - a.y;
          boxes.splice(j, 1);
          merged = true;
        }
      }
    }
  }

  // Unpadded: padding is decided by `snapToDom`, which knows whether a box is
  // anchored to an element or is a bare rectangle nothing explains.
  return boxes.filter((b) => b.width * b.height >= MIN_AREA);
}

const area = (b: Box) => b.width * b.height;
/** Any shared pixel. Deliberately not "mostly the same": a countdown's box
 * changes width as its digits do, so the two observations of one clock are
 * rarely the same rectangle. */
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const holds = (outer: Box, inner: Box, slack = 0) =>
  outer.x - slack <= inner.x &&
  outer.y - slack <= inner.y &&
  outer.x + outer.width + slack >= inner.x + inner.width &&
  outer.y + outer.height + slack >= inner.y + inner.height;

const pad = (b: Box, by: number, width: number, height: number): Box => {
  const x = Math.max(0, b.x - by);
  const y = Math.max(0, b.y - by);
  return {
    x,
    y,
    width: Math.min(width, b.x + b.width + by) - x,
    height: Math.min(height, b.y + b.height + by) - y,
  };
};

/**
 * **Turn "these pixels moved" into "this element's contents vary".**
 *
 * This is the half a pixel diff cannot do. Two differing glyphs are identical
 * evidence to `pixelmatch`, so the only thing it can say about a countdown and
 * a button forty pixels apart is *a rectangle containing both* — and that
 * rectangle contains the heading, the borders and the whitespace between them,
 * none of which was ever in question. The browser knows which element each
 * glyph belongs to, and `domBoxes` has just asked it.
 *
 * Each cluster takes the **smallest element that contains it**, and the mask
 * becomes that element rather than the shape its content happened to have this
 * run. That is what makes it robust: a countdown reading `10:00` next time is
 * wider than `9:59` and still inside the span it lives in, whereas a box drawn
 * round `9:59` and padded is a guess about how much wider text can get.
 *
 * Three refusals, and each is a case that would otherwise be silently wrong:
 *
 * - **an anchor over `MAX_ANCHOR_SHARE` is refused.** The smallest element
 *   containing a diff is sometimes a card or a form, and masking one hides
 *   everything inside it. The padded pixel box is smaller, so it wins
 * - **no containing element is not an error.** A shadow, a focus ring or a
 *   scrollbar falls outside every rect. It is masked as a bare rectangle and
 *   **says so** — `from: "pixels"` — rather than being dropped, which would
 *   leave the comparison red for ever, or attributed to an element it is not in
 * - **spilling past the element by more than `CONTAIN_SLACK` is not that
 *   element's.** A glyph overhangs its box by a pixel; a tooltip, a popover or
 *   a transformed child leaves it entirely, and attributing one of those to the
 *   box it happens to start in would mask a region on the strength of an
 *   element that does not hold it. Those fall back to pixels, deliberately
 *
 * The union with the cluster is kept for the slack case, so the couple of
 * pixels an anchored glyph overhangs by are still inside the mask.
 */
export function snapToDom(
  clusters: readonly Box[],
  dom: readonly DomBox[],
  width: number,
  height: number,
): MaskBox[] {
  const cap = width * height * MAX_ANCHOR_SHARE;

  const anchorFor = (cluster: Box): DomBox | undefined => {
    let best: DomBox | undefined;
    for (const el of dom) {
      if (area(el) > cap) continue;
      if (!holds(el, cluster, CONTAIN_SLACK)) continue;
      if (!best || area(el) < area(best)) best = el;
    }
    return best;
  };

  const spread = (a: Box, b: Box): Box => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
  };

  /*
   * **Clusters are grouped by their element before a box is drawn**, so an
   * element gets exactly one box however many separate things differed inside
   * it.
   *
   * Per-cluster boxes were tried and are worse in a way that is easy to miss:
   * three differing words in one paragraph become three boxes that *overlap*
   * once padded, and the census sums box areas to report coverage — so the
   * page would be reported as more masked than it is. One box per element also
   * keeps the narrative's table one row per thing.
   */
  const grouped = new Map<string, { anchor: DomBox; covers: Box }>();
  const loose: MaskBox[] = [];

  for (const cluster of clusters) {
    const anchor = anchorFor(cluster);

    /*
     * **An unattributable cluster this big is not maskable, and is dropped.**
     *
     * No element contains it and it covers more of the page than any anchor is
     * allowed to, which does not mean *a very large volatile value* — it means
     * the two runs rendered different screens. Storing it produces a mask over
     * the whole page: `happy/04-choose-an-organization` learned exactly one box
     * at **100.0%**, which passes every comparison for ever.
     *
     * Dropped rather than stored, so the step stays red and says something
     * changed. That is the honest answer: a comparison nobody can make should
     * report that, not report success.
     */
    if (!anchor) {
      const box = pad(cluster, PAD_PIXELS, width, height);
      if (area(box) <= cap) loose.push({ ...box, from: "pixels" });
      continue;
    }

    const key = `${anchor.path}@${anchor.x},${anchor.y},${anchor.width},${anchor.height}`;
    const seen = grouped.get(key);
    grouped.set(key, { anchor, covers: seen ? spread(seen.covers, cluster) : cluster });
  }

  const snapped = [...grouped.values()].map(({ anchor, covers }): MaskBox => {
    /*
     * **Vertical from the element, horizontal from what differed** — see
     * `INLINE_SLACK`. An inline element hugs its text, so the two agree and
     * this is the element's own box; a block is as wide as its column, and
     * taking that masked 776px of blank page to exclude one timestamp.
     *
     * Clamped to the anchor on both sides, so the box stays inside the element
     * it is named after — and text growing to fill its line is still covered,
     * because the element is the ceiling.
     */
    const top = Math.min(anchor.y, covers.y);
    const bottom = Math.max(anchor.y + anchor.height, covers.y + covers.height);
    const left = Math.max(anchor.x, covers.x - INLINE_SLACK);
    const right = Math.min(anchor.x + anchor.width, covers.x + covers.width + INLINE_SLACK);
    const box = { x: left, y: top, width: right - left, height: bottom - top };
    return { ...pad(box, PAD_ELEMENT, width, height), from: anchor.path };
  });

  return mergeBoxes([...snapped, ...loose]);
}

/**
 * Collapse boxes that say the same thing.
 *
 * Two things make this necessary rather than tidy. Every cluster inside one
 * element snaps to that element, so six differing glyphs in a sentence arrive
 * as six copies of the same rectangle. And the mask is a **union across
 * learning passes** — without this, running `journey:masks` again would append
 * a second copy of every box it already had, and the file would grow for ever
 * while describing exactly the same region.
 *
 * A box wholly inside another is dropped rather than merged: the outer one
 * already excludes it, and keeping both makes the count in the narrative read
 * as more exclusion than there is.
 */
export function mergeBoxes(boxes: readonly MaskBox[]): MaskBox[] {
  /*
   * **Two boxes naming one element are one box.**
   *
   * A mask is a union across runs, so the same element can be learned again at
   * a slightly different rectangle — text reflows by a pixel, a border rounds
   * the other way. Neither contains the other, so the containment rule below
   * keeps both, and the coverage figure counts the overlap twice.
   *
   * Measured 2026-09-04 on the sign-in email: `199×32 at 237,172` and
   * `199×32 at 238,172`, the same `tbody` one pixel apart, reported as 2.2% of
   * an image where the truth is half that.
   *
   * Left alone this is a ratchet. Learning only ever *adds*, so every pass can
   * contribute another near-duplicate of a region that has not changed, and the
   * mask creeps outward for ever while nothing about the page varies — which is
   * how a box ends up across a card, passing every comparison.
   *
   * Merged into the smallest rectangle containing both, which is what one
   * element varying actually is. `pixels` is exempt: it means *no element
   * matched*, so two of them are not evidence of one thing and merging them
   * would join unrelated regions across the page.
   */
  const byElement = new Map<string, MaskBox>();
  const loose: MaskBox[] = [];
  for (const box of boxes) {
    if (!box.from || box.from === "pixels") {
      loose.push(box);
      continue;
    }
    const seen = byElement.get(box.from);
    byElement.set(box.from, seen ? span(seen, box) : box);
  }

  const kept: MaskBox[] = [];
  for (const box of [...byElement.values(), ...loose].sort((a, b) => area(b) - area(a))) {
    if (kept.some((k) => holds(k, box))) continue;
    kept.push(box);
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The smallest box containing both — one element's rectangle across two runs.
 *
 * Both boxes name the same element, so they share a provenance; the evidence is
 * the **later** of the two, because `exercised` is a date rather than a count
 * and losing it on a merge would quietly reset a box to unexercised.
 */
const span = (a: MaskBox, b: MaskBox): MaskBox => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const exercised = [a.exercised, b.exercised].filter(Boolean).sort().pop();
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
    from: a.from,
    ...(a.provenance ? { provenance: a.provenance } : {}),
    ...(exercised ? { exercised } : {}),
  };
};

/**
 * **A declared box is re-resolved against the page in front of it** (#773).
 *
 * A learned box is the residue of two runs that already happened, so the
 * rectangle on disk is the whole of what was observed and there is nothing to
 * re-ask. A **declared** box is not that: it is a claim that *this element*
 * holds a value the learner cannot see, and the rectangle stored beside it is
 * only where that element was on the day somebody learned it.
 *
 * Which is fine until the value changes width. Every date here does, once a
 * month:
 *
 * | `J40 happy/01`, `declared:span[data-volatile-date][0]` | x | width |
 * | --- | ---: | ---: |
 * | learned 2026-09-09, *"Sep 9, 2026"* | 1026 | 83 |
 * | rendered 2026-09-11, *"Sep 11, 2026"* | 1018 | **92** |
 *
 * Nine pixels of digit outside the box, `uncoveredDates` reports it, and six of
 * J40's seven paths are red — from the 10th onward, on a journey released to QA
 * on the 9th. The guard was right; it was handed yesterday's geometry.
 *
 * `mask.ts` already claimed this was how it worked — *"a declared box resolves
 * from a selector rather than a stored rectangle"*, on `MaskBox` — and only the
 * learning pass ever asked the page, because *"an ordinary run has a mask
 * already"*. It has a mask learned against a different value.
 *
 * ## Union, not replacement
 *
 * **Both images are masked with the same boxes.** Today's rectangle alone would
 * cover today's date and leave the *baseline's* wider one showing, turning a
 * narrowing date into a regression — the same fault pointed the other way. So
 * the box is the smallest one containing both observations.
 *
 * ## Three cases, and the middle one is the reason this is not a one-liner
 *
 * | stored vs live | |
 * | --- | --- |
 * | **overlapping** | union. One element, two widths |
 * | **not overlapping** | keep the stored box. The element has *moved* — a row shifted, a column was inserted — and a rectangle stretched across the gap would swallow whatever lies between it and its old home. The step then fails, naming the date, which is the loud path and the correct one |
 * | **no live match** | keep the stored box. The element is gone from this page; a box over where it used to be excludes nothing and harms nothing, and deleting it here would quietly edit a mask on a run that is not allowed to learn |
 *
 * **A live box with no stored counterpart is deliberately not added.** That is
 * a date somebody put on the page since the mask was learned, and masking it on
 * sight would hide the product change that brought it — a mask may only grow
 * through a relearn. It stays uncovered, `uncoveredDates` names it, and
 * somebody runs `pnpm journey:masks`.
 *
 * **Nothing is written back.** The union lives for the length of one
 * comparison, so a box cannot creep outward across months — which is the
 * ratchet `mergeBoxes` exists to prevent, and it would arrive here by a
 * different door.
 */
export function refreshDeclared(stored: readonly MaskBox[], live: readonly DomBox[]): MaskBox[] {
  const byPath = new Map(live.map((box) => [box.path, box]));
  return stored.map((box) => {
    if (box.provenance !== "declared") return box;
    const now = byPath.get(box.from);
    if (!now || !overlaps(box, now)) return box;
    // Explicit rather than a spread: `now` carries a `path`, `span` reads
    // neither it nor the second box's provenance, and a stray key on something
    // typed `MaskBox` invites a later reader to think it means something.
    return span(box, { x: now.x, y: now.y, width: now.width, height: now.height, from: box.from });
  });
}

/**
 * **A stored box is kept only while its path still names what it named.**
 *
 * `mergeBoxes` joins boxes sharing a `from`, *however far apart*, because that
 * is what one element relearned across two runs looks like. That rests on a
 * `from` meaning the same thing in both runs — and `domBoxes` says where the
 * assumption lives: *"the index is assigned in document order, which is stable
 * **for a given page**"*.
 *
 * Change the page and it stops being true. Adding one destination to the
 * sidebar inserts elements earlier in document order, so every `span[n]` after
 * it shifts by one: the stored `span[17]` was the clock, the live `span[17]`
 * is its neighbour, and merging them spans the gap. Measured on J23
 * `assign-and-resolve/03-start-work` — **376×457, 15.8% of the page**, across
 * the Update card and all three of its buttons.
 *
 * That box is #718 returning by a different door. #718 made a path name one
 * element *within* a run; this makes it mean the same element *between* runs.
 *
 * ## The same argument `MASK_VERSION` already makes, one axis over
 *
 * > unioning boxes learned by two different rules gives you the looser of the
 * > two, for ever, and the tighter rule can never take effect
 *
 * True with *page* substituted for *rule*, and worse: a changed rule is at
 * least visible in the version, where a changed page is visible in nothing.
 *
 * ## Three cases, and the asymmetry with `refreshDeclared` is the point
 *
 * | stored vs live | |
 * | --- | --- |
 * | **path resolves, boxes overlap** | keep. The element is where it was; `mergeBoxes` unions the two widths, which is what it is for |
 * | **path resolves, boxes do not overlap** | **drop.** The label re-points. It may also be the same element moved — the two are indistinguishable from position alone, and dropping is the answer that cannot be wrong for long, because the next pass learns it where it now is |
 * | **path is not on this page** | **drop.** A box for an element that is not here excludes nothing, and keeping it is how a stale path waits to collide with a future element that inherits its index |
 *
 * **`refreshDeclared` keeps what this drops, and both are right.** That runs on
 * a *comparison*, which may not learn: silently deleting a box there would edit
 * a mask on a run that is not allowed to, so it keeps the stored box and lets
 * the step fail loudly. This runs on a *learning* pass, whose whole job is to
 * rewrite the mask from what it can see — so a box it cannot justify is one it
 * should not carry forward. Losing a box costs one relearn; keeping a wrong one
 * is permanent, because the union only grows.
 *
 * **`pixels` is exempt**, for the reason `mergeBoxes` gives: it means no
 * element matched, so there is no claim about an element to re-check.
 */
export function verifyStored(
  stored: readonly MaskBox[],
  live: readonly DomBox[],
): { kept: MaskBox[]; dropped: MaskBox[] } {
  const byPath = new Map(live.map((box) => [box.path, box]));
  const kept: MaskBox[] = [];
  const dropped: MaskBox[] = [];

  for (const box of stored) {
    if (!box.from || box.from === "pixels") {
      kept.push(box);
      continue;
    }
    const now = byPath.get(box.from);
    if (now && overlaps(box, now)) kept.push(box);
    else dropped.push(box);
  }

  return { kept, dropped };
}

/**
 * **Two kinds of motion, and masking the wrong one hides the assertion.**
 *
 * Given what moved over two consecutive intervals of the *same* page, sitting
 * still, this separates a value that keeps changing from one that was merely
 * arriving:
 *
 * | moved in | means | |
 * | --- | --- | --- |
 * | both intervals | a clock — a countdown, a relative time, a poll | **mask it** |
 * | the second only | still moving when the window closed | **mask it** |
 * | the first only | state that *settled* — a save landing, a spinner ending | **do not mask** |
 *
 * The last row is the whole reason this exists. A blanket "anything that moved
 * within 1.5s is volatile" would have masked J35's
 * `blank-property/05`, whose page goes from `Saving… / 2 problems` to
 * `Saved / 1 problem` in about that time — permanently hiding the problem
 * count that the step is named after, and turning a red run green. A settling
 * region is not something to exclude; it is a step racing its own page, and
 * the answer is a better wait condition.
 *
 * So the question asked is **"was it still moving when the window closed?"**
 * rather than "did it ever move".
 *
 * Matched by element where both boxes carry one, and by overlap otherwise —
 * a clock's box can change size as its digits do (`09:59` → `10:00`), so
 * equality of rectangles is not available.
 *
 * **What three shots cannot separate**: something that settles *between* the
 * second and third, which reads as ticking and is masked. A longer window or a
 * fourth shot narrows that and does not close it; the honest boundary is that
 * this finds periodic motion, not every possible one.
 */
export function classifyMotion(
  first: readonly MaskBox[],
  second: readonly MaskBox[],
): { ticking: MaskBox[]; settling: MaskBox[] } {
  const same = (a: MaskBox, b: MaskBox) =>
    a.from && b.from && a.from !== "pixels" && b.from !== "pixels"
      ? a.from === b.from
      : overlaps(a, b);

  const ticking = first.filter((box) => second.some((later) => same(box, later)));
  const settling = first.filter((box) => !second.some((later) => same(box, later)));
  /*
   * A region that only started moving in the second interval is still moving
   * when the window closed, so it belongs with the clocks — the same question,
   * answered from the other end.
   */
  const late = second.filter((box) => !first.some((earlier) => same(box, earlier)));

  return { ticking: mergeBoxes([...ticking, ...late]), settling: mergeBoxes(settling) };
}

/**
 * What differs between two runs of the same code: the volatile regions.
 *
 * `dom` is the page's element boxes at the moment the *second* screenshot was
 * taken. Passing `[]` is legitimate and means every box comes back
 * unattributed — the pixel-only behaviour, which is what a caller with no live
 * page can honestly produce.
 */
export function volatileBoxes(
  before: string,
  after: string,
  dom: readonly DomBox[] = [],
): MaskBox[] | null {
  const found = differing(read(before), read(after));
  if (!found) return null;
  const clusters = boxesOf(found.diff, found.width, found.height);
  return snapToDom(clusters, dom, found.width, found.height);
}

/**
 * The two passes a mask was learned from, and the diff between them.
 *
 * **A mask over the threshold is a question, and until this existed there was
 * no way to look at it.** The learner reported a percentage and a box list,
 * both derived; the two screenshots it derived them *from* lived in the shots
 * directory for one pass and were overwritten by the next. So the only
 * available move was to reason about what might vary across a card — which is
 * how #871 came to conclude the pixel diff genuinely spanned 376×457 when the
 * box was two small boxes with a colliding path and 411px of untouched page
 * between them.
 *
 * Three files, because the diff alone does not say which side moved:
 *
 * | | |
 * | --- | --- |
 * | `1-before.png` | the pass this was compared against |
 * | `2-after.png` | the pass that produced the mask |
 * | `3-diff.png` | every differing pixel, on black |
 *
 * Written under `test-results/`, which `.gitignore` already describes as where
 * "a failed comparison drops `-expected`, `-actual` and `-diff`, which are
 * evidence for one run and meaningless after it". This is that, one layer up:
 * evidence for the run that learned the mask rather than the run that failed
 * against it.
 *
 * Returns the directory, so the failure can name it rather than describe it.
 */
export function writeMaskEvidence(before: string, after: string, dir: string): string | null {
  const a = read(before);
  const b = read(after);
  mkdirSync(dir, { recursive: true });
  copyFileSync(before, join(dir, "1-before.png"));
  copyFileSync(after, join(dir, "2-after.png"));

  const found = differing(a, b);
  /*
   * A resize has no pixel diff to draw — the images cannot be compared at all,
   * which `compareMasked` reports as `resized`. The two copies above are still
   * the useful half, and saying so beats writing a black rectangle that looks
   * like "nothing differed".
   */
  if (!found) return dir;

  const out = new PNG({ width: found.width, height: found.height });
  for (let i = 0; i < found.diff.length; i++) {
    const on = found.diff[i] === 1;
    out.data[i * 4] = on ? 255 : 0;
    out.data[i * 4 + 1] = on ? 64 : 0;
    out.data[i * 4 + 2] = on ? 64 : 0;
    out.data[i * 4 + 3] = 255;
  }
  writeFileSync(join(dir, "3-diff.png"), PNG.sync.write(out));
  return dir;
}

export type Verdict =
  | { kind: "same" }
  | { kind: "resized"; was: string; now: string }
  | { kind: "changed"; pixels: number; ratio: number };

/**
 * Compare, ignoring the masked regions.
 *
 * **The mask is subtracted before the count, not after.** A budget over the
 * whole image — `maxDiffPixelRatio` — cannot tell a countdown ticking from a
 * button that moved, so it either passes both or fails both. Here the volatile
 * regions contribute nothing at all, and what is left is worth failing over.
 */
export function compareMasked(baseline: string, candidate: string, mask: readonly Box[]): Verdict {
  const a = read(baseline);
  const b = read(candidate);
  if (a.width !== b.width || a.height !== b.height) {
    return { kind: "resized", was: `${a.width}×${a.height}`, now: `${b.width}×${b.height}` };
  }

  const found = differing(a, b)!;
  const inMask = (x: number, y: number) =>
    mask.some((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);

  let pixels = 0;
  for (let y = 0; y < found.height; y++) {
    for (let x = 0; x < found.width; x++) {
      if (found.diff[y * found.width + x] === 1 && !inMask(x, y)) pixels++;
    }
  }

  return pixels === 0
    ? { kind: "same" }
    : { kind: "changed", pixels, ratio: pixels / (found.width * found.height) };
}

/**
 * The mask, drawn over the screenshot it belongs to.
 *
 * **Shown in the recording**, because a mask nobody can see is a gate nobody can
 * check: a box that has crept across the whole page passes every comparison and
 * reports success for ever. Somebody reviewing the journey sees exactly what is
 * excluded, and how much of the screen that is.
 */
export function drawMask(screenshot: string, mask: readonly Box[], out: string): number {
  const png = read(screenshot);
  /**
   * **Painted pixels, not the sum of the boxes.**
   *
   * Boxes overlap: `mergeBoxes` drops one wholly inside another, and that is
   * all it drops — two that merely *cross* both survive, which is right for a
   * mask and wrong for `w * h` added up. The intersection is then counted
   * twice, so the figure reads higher than the truth. Measured on
   * `expired-code/03`: 11,616px summed against 10,208px actually covered.
   *
   * The figure exists for somebody to judge whether the gate still means
   * anything, so an inflated one is worse than none — it argues for tightening
   * a mask that is already tight, and at the other end it can only ever
   * over-report, which is the direction that trips `MAX_STEP_COVERAGE` on a
   * mask that never earned it.
   *
   * A byte per pixel over an image this size is nothing next to the PNG that is
   * already decoded in memory beside it.
   */
  const painted = new Uint8Array(png.width * png.height);

  for (const box of mask) {
    for (let y = box.y; y < box.y + box.height && y < png.height; y++) {
      for (let x = box.x; x < box.x + box.width && x < png.width; x++) {
        painted[y * png.width + x] = 1;
        const i = (y * png.width + x) * 4;
        const edge =
          x < box.x + 2 ||
          x >= box.x + box.width - 2 ||
          y < box.y + 2 ||
          y >= box.y + box.height - 2;
        if (edge) {
          png.data[i] = 217;
          png.data[i + 1] = 45;
          png.data[i + 2] = 32;
        } else {
          // Tinted rather than filled: the thing under the mask is still worth
          // seeing, and a solid block hides whether the box is in the right place.
          png.data[i] = Math.round(png.data[i]! * 0.65 + 217 * 0.35);
          png.data[i + 1] = Math.round(png.data[i + 1]! * 0.65 + 45 * 0.35);
          png.data[i + 2] = Math.round(png.data[i + 2]! * 0.65 + 32 * 0.35);
        }
      }
    }
  }

  writeFileSync(out, PNG.sync.write(png));
  let covered = 0;
  for (const pixel of painted) covered += pixel;
  return covered / (png.width * png.height);
}

/**
 * **The pixels between, with the mask drawn over them.**
 *
 * `carryOwnDiff` has written a before and an after beside a changed step since
 * #657, and `diff.md` has had a third column for the pixels between them that
 * always read `—`, because nothing produced the image. So a reader judging a
 * red step had two screenshots and a number, and the number was the count
 * *outside* the mask — which says how many leaked without saying where, or
 * what the mask had already absorbed beside them.
 *
 * Measured on J1's *Enter the building*: two learner runs failed on it with an
 * identical 66,832-pixel difference, and diagnosing that meant diffing the two
 * PNGs by hand in a one-off script and then reading both images. The answer —
 * a focus ring moving between two inputs — was visible in one glance at a
 * painted diff and invisible in the count.
 *
 * Three things are painted, so they can be told apart at a glance:
 *
 * | | |
 * | --- | --- |
 * | a differing pixel **outside** the mask | solid red — this is what made the step red |
 * | a differing pixel **inside** the mask | tinted, the way `drawMask` tints — absorbed, and worth seeing that it was |
 * | the mask's boxes | outlined in red, as `drawMask` draws them |
 *
 * Everything else is the *after* screenshot dimmed toward white, so the page
 * stays readable underneath and the red is the only thing that is not it.
 *
 * Returns how many differing pixels fell outside the mask — the same figure
 * `compareMasked` reports, so the picture and the number cannot disagree. A
 * size change is not paintable pixel for pixel; it writes nothing and returns
 * `null`, and the caller reports the resize it already knows about.
 */
export function drawDiff(
  baseline: string,
  candidate: string,
  mask: readonly Box[],
  out: string,
): number | null {
  const a = read(baseline);
  const b = read(candidate);
  const found = differing(a, b);
  if (found === null) return null;

  const inMask = (x: number, y: number) =>
    mask.some((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);

  const png = new PNG({ width: b.width, height: b.height });
  b.data.copy(png.data);

  let leaked = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (found.diff[y * png.width + x] === 1) {
        if (inMask(x, y)) {
          png.data[i] = Math.round(png.data[i]! * 0.65 + 217 * 0.35);
          png.data[i + 1] = Math.round(png.data[i + 1]! * 0.65 + 45 * 0.35);
          png.data[i + 2] = Math.round(png.data[i + 2]! * 0.65 + 32 * 0.35);
        } else {
          leaked++;
          png.data[i] = 217;
          png.data[i + 1] = 45;
          png.data[i + 2] = 32;
        }
      } else {
        // Dimmed toward white rather than darkened: a screenshot is mostly
        // light, and the red has to be the only thing that is not the page.
        png.data[i] = Math.round(png.data[i]! * 0.5 + 255 * 0.5);
        png.data[i + 1] = Math.round(png.data[i + 1]! * 0.5 + 255 * 0.5);
        png.data[i + 2] = Math.round(png.data[i + 2]! * 0.5 + 255 * 0.5);
      }
    }
  }

  for (const box of mask) {
    for (let y = box.y; y < box.y + box.height && y < png.height; y++) {
      for (let x = box.x; x < box.x + box.width && x < png.width; x++) {
        const edge =
          x < box.x + 2 ||
          x >= box.x + box.width - 2 ||
          y < box.y + 2 ||
          y >= box.y + box.height - 2;
        if (!edge) continue;
        const i = (y * png.width + x) * 4;
        png.data[i] = 217;
        png.data[i + 1] = 45;
        png.data[i + 2] = 32;
      }
    }
  }

  writeFileSync(out, PNG.sync.write(png));
  return leaked;
}

/**
 * **Rendered dates the mask does not cover.**
 *
 * The check on the other side of `dateBoxes`: every date on the page has to be
 * excluded from the comparison, because in this product every date moves with
 * the clock. One that is not covered is a step that passes today and is red
 * tomorrow morning — [#617](https://github.com/VuNexa-App/door_nexa/issues/617),
 * which J35 had latently and J33 had without anybody noticing.
 *
 * **Covered means every pixel**, not "overlaps". A partial mask is the failure
 * the audit trail's `data-volatile-clock` comment already records: it looks
 * masked, it passes the run that learned it, and it fails later on the digits
 * nobody watched move. A box that covers the minutes and not the hour is
 * therefore reported here exactly like no box at all.
 *
 * Painted over the **date box** rather than the page, so this is a few hundred
 * pixels per element rather than a two-megapixel grid per step.
 */
export function uncoveredDates(dates: readonly DomBox[], mask: readonly Box[]): DomBox[] {
  return dates.filter((date) => {
    const painted = new Uint8Array(date.width * date.height);
    for (const box of mask) {
      const x0 = Math.max(date.x, box.x);
      const x1 = Math.min(date.x + date.width, box.x + box.width);
      const y0 = Math.max(date.y, box.y);
      const y1 = Math.min(date.y + date.height, box.y + box.height);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) painted[(y - date.y) * date.width + (x - date.x)] = 1;
      }
    }
    return painted.some((pixel) => pixel === 0);
  });
}

/**
 * **Which boxes actually did work on this comparison.**
 *
 * The masked comparison says *nothing changed outside the mask*; the unmasked
 * one says whether anything changed at all. Where they disagree, the difference
 * lies inside the mask — and the boxes containing it are the ones that just
 * earned their place. That is the evidence a declared box otherwise cannot
 * have, because a run that *would* have failed is not observable from the run
 * that passed.
 *
 * Only asked when the masked comparison came back `same`. A step that changed
 * outside its mask is a finding about the product, and crediting its boxes on
 * the way past would be rewarding them for a run nobody trusts.
 */
export function exercisedBy(
  baseline: string,
  candidate: string,
  mask: readonly MaskBox[],
): MaskBox[] {
  const a = read(baseline);
  const b = read(candidate);
  if (a.width !== b.width || a.height !== b.height) return [];
  const found = differing(a, b);
  if (!found) return [];
  return mask.filter((box) => {
    for (let y = box.y; y < box.y + box.height && y < found.height; y++) {
      for (let x = box.x; x < box.x + box.width && x < found.width; x++) {
        if (found.diff[y * found.width + x] === 1) return true;
      }
    }
    return false;
  });
}
