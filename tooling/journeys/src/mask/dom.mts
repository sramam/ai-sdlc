import type { DomBox } from "./boxes.mts";

/**
 * **The one thing this module needs from a browser page: `evaluate`.**
 *
 * Structural rather than `import type { Page } from "@playwright/test"`, so the
 * mask core carries no dependency on a browser runner — the recorder (step 3)
 * hands in a Playwright `Page`, and a test can hand in anything that runs a
 * function and returns its result. Every probe below passes exactly one
 * argument, so one signature is enough.
 */
export interface EvaluatingPage {
  evaluate<R, Arg>(fn: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
}

/** One entry of the declared-volatile list. */
export type DeclaredVolatile = { selector: string; why: string };

/**
 * **The one place an interval becomes a box** (#923).
 *
 * A box is `[floor(left), ceil(right))` — the near edge rounded down, the far
 * edge rounded up, and the width derived from the two rather than rounded
 * itself. Containment is then a property: the box covers every pixel the
 * element paints, for any float rect, by construction.
 *
 * **Four spellings of this existed and two were wrong**, which is why it is a
 * function rather than a rule. `floor(left) + ceil(width)` loses the far edge
 * in ~50% of rects — the near edge is already outward, so only the far one can
 * fall short. `round(left) + round(width)` loses an edge in ~87%, because
 * rounding both terms of one interval independently can move the near edge
 * *inward* as well. Measured over 200,000 random rects by three sessions
 * before anybody wrote this down, which is the tell: **a fact re-derived by
 * sampling is a fact nobody has encoded.**
 *
 * **`width`, not `right`, because that is what a mask consumes.**
 * `boxes.mts` iterates `x < box.x + box.width`, a half-open interval, so the far
 * edge is exclusive and `x + width >= right` is the claim that matters.
 *
 * **Data crosses into a `page.evaluate`; functions do not** — so the probes
 * below hand out the four floats and this rounds them here, rather than each
 * carrying its own copy. That is the general rule and not an implementation
 * detail: it is why `DATE_SHAPES` is hoisted out too. `dateBoxes` once built
 * its regexes inside an evaluate where nothing could test them, and stayed
 * blind to `YYYY-MM` — this product's own period key — while six month chips
 * went unmasked.
 */
export function boxOf(
  left: number,
  top: number,
  right: number,
  bottom: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.floor(left);
  const y = Math.floor(top);
  return {
    x,
    y,
    width: Math.ceil(right) - x,
    height: Math.ceil(bottom) - y,
  };
}

/**
 * What a probe hands **out of** the page, before `boxOf` rounds it.
 *
 * **The exclusive edges, not a width**, because that is the whole point of
 * #932: the page keeps the floats it measured and one constructor turns them
 * into a box, Node-side. A probe that computed a width would be the fourth
 * copy of the arithmetic this type exists to make impossible.
 *
 * **It is named because all three probes were lying about it** (#917). Each
 * declared the *rounded* shape — one as `DomBox[]`, two as a spelled-out
 * `Array<{ x, y, width, height, path }>` — and pushed `{ left, top, right,
 * bottom, path }` into it. Runtime was correct throughout and no mask was ever
 * affected; the annotation was the falsehood, sitting at the exact boundary the
 * refactor created in order to be trustworthy.
 *
 * **Nothing caught it because nothing checks `e2e/`** — no tsconfig project
 * includes this directory, which is the same gap `packages/db/agents.md`
 * records for `scripts/`. Found by somebody running `tsc` against their
 * own specs by hand before recording.
 */
type RawRect = { left: number; top: number; right: number; bottom: number; path: string };

/**
 * **Where every element is, at the moment the screenshot was taken.**
 *
 * A mask is learned from pixels — see `boxes.mts` — and pixels have no idea what
 * they are part of. A differing glyph in a countdown and a differing glyph in a
 * button are the same evidence to a diff, so the only thing a pixel-only mask
 * can do with two of them is grow a rectangle big enough to hold both. That is
 * how a mask ends up covering a card.
 *
 * The browser already knows the answer. This reads it out once per screenshot,
 * and `snapToDom` turns *"these pixels moved"* into *"this element's contents
 * vary"* — which is both smaller and the thing a reviewer can judge.
 *
 * **Page coordinates, because the screenshot is `fullPage`.** A rect from
 * `getBoundingClientRect()` is viewport-relative; the image's origin is the
 * document's. Adding the scroll offset is what makes the two agree, and getting
 * it wrong is invisible on a page that happens to fit the viewport — which is
 * every J31 screen, and would leave the fault waiting for the first tall one.
 *
 * **Rounded outward on both edges, which `floor(left) + ceil(width)` is not**
 * (#923). A CSS rect has fractional edges and the box wanted is every pixel the
 * element paints, so it is `[floor(left), ceil(right))`. Going via the width
 * loses the right edge whenever the fractions add up — `left 949.2, width
 * 134.9` reaches 1083 while the element paints 1084 — and since
 * `floor(L) + ceil(W) <= ceil(L + W)` always, it can only ever lose.
 *
 * **One pixel, and it cost a red learning pass.** All three probes here round
 * the same pixels, so an element's box and the box of a date *inside* it were
 * rounded independently: J43's `data-volatile-clock` came out `[949, 1084)`
 * and the clock text inside it `[1044, 1085)`, so `uncoveredDates` — which
 * asks for every pixel, correctly — reported three declared, correctly-marked
 * clocks as unmasked. Whether a marker covered the value it was put there for
 * was luck of the layout, re-rolled by any CSS change.
 *
 * Under this form it is a **property** instead: a range strictly inside an
 * element has a `floor` no smaller and a `ceil` no larger, so a declared
 * element always covers the dates it holds.
 *
 * The device scale factor is 1 (`devices["Desktop Chrome"]`), so a CSS pixel is
 * an image pixel and no conversion is needed. If that ever changes, every box
 * here needs multiplying by it and nothing will say so.
 */
export async function domBoxes(page: EvaluatingPage): Promise<DomBox[]> {
  const raw = await page.evaluate(() => {
    /*
     * Non-visual elements are dropped rather than filtered later: `<script>`
     * and friends report a zero rect anyway, and `<html>`/`<body>` report the
     * whole page — which would be chosen as an anchor whenever nothing tighter
     * contains a diff, turning the fallback into "mask everything".
     */
    const SKIP = new Set(["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "META", "LINK", "TITLE"]);

    /**
     * What a reviewer reads in the narrative. Attributes only — **never text.**
     *
     * The volatile content is the sign-in code and the tenant's email address,
     * and a descriptor built from `textContent` would write both into a file
     * that is committed. The whole point of the mask is that those values are
     * not compared; putting them in the mask itself would be worse than not
     * masking them.
     */
    const describe = (el: Element): string => {
      const testid = el.getAttribute("data-testid");
      if (testid) return `${el.tagName.toLowerCase()}[data-testid="${testid}"]`;
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
      const role = el.getAttribute("role");
      const classes = (el.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        // Two is enough to recognise a component and short enough to read; a
        // Tailwind element carries thirty and the rest is noise in a table.
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("");
      return `${el.tagName.toLowerCase()}${role ? `[role="${role}"]` : ""}${classes}`;
    };

    /**
     * **A path must name one element, not a set** (#718, and #651 before it).
     *
     * `mergeBoxes` merges boxes sharing a `from`, *however far apart*, because
     * that is what one element relearned across two runs looks like. The
     * guarantee that a mask cannot swallow a neighbour therefore lives here,
     * in whoever assigns the string — `declaredVolatileBoxes` below already
     * appends an index for exactly this reason, and this did not.
     *
     * `describe` is a tag plus at most two classes, so `span`, `td.px-4.py-2`
     * and `label.text-sm.font-medium` each name *many* elements. Measured
     * 2026-09-09 on J23 `assign-and-resolve/03-start-work`: two clocks
     * differing by one digit each — 78 pixels, 434px apart, both `span` —
     * merged into a single **365×457** box, 15.4% of the page, covering the
     * Update card and all three of its buttons.
     *
     * The index is assigned in document order, which is stable for a given
     * page: two runs of the same screen enumerate the same elements in the
     * same order, so the same element keeps the same path and the merge still
     * does its job.
     */
    const seen = new Map<string, number>();
    const boxes: RawRect[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (SKIP.has(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const described = describe(el);
      const index = seen.get(described) ?? 0;
      seen.set(described, index + 1);
      boxes.push({
        left: r.left + window.scrollX,
        top: r.top + window.scrollY,
        right: r.right + window.scrollX,
        bottom: r.bottom + window.scrollY,
        path: `${described}[${index}]`,
      });
    }
    return boxes;
  }, null);
  // Rounded here rather than in the page: a `page.evaluate` receives data
  // and not functions, so a shared constructor cannot cross into it.
  return raw.map(({ left, top, right, bottom, ...rest }) => ({
    ...boxOf(left, top, right, bottom),
    ...rest,
  }));
}

/**
 * **Regions declared to vary, because the learner cannot reliably see them.**
 *
 * The mask is *found, not declared*, and that rule is about **creep**: a
 * declared box widens until it covers half a page and passes everything. It is
 * the right default and it has one blind spot.
 *
 * A learning pass diffs two runs about 40 seconds apart and watches each page
 * sitting still for three shots `JOURNEY_DWELL` apart — a **3-second** window.
 * Audited across the five recordings, everything that varies changes either
 * **per second** (the audit trail's `slice(0, 19)` timestamps, J31's `mm:ss`
 * resend countdown) or **per run** (ids, names, addresses). Both are caught.
 *
 * Exactly one value changes once a **minute**: the dashboard's `As of …`, and
 * only because `asOf.toISOString().slice(0, 16)` truncates it to minutes. It is
 * coarser than the dwell window and finer than nothing, so whether a learning
 * pass sees it is luck — measured across this work, it was missed on four
 * separate relearn cycles and caught on four others (#590).
 *
 * The failure mode when it is missed has a loud form and a silent one. Loud:
 * the verification pass goes red saying *"a step is genuinely changing"*, which
 * points at the product. Silent, and worse: all three passes fall inside one
 * minute, the run exits 0, and the **next** unrelated run goes red on a step
 * nobody touched.
 *
 * So this one is declared. Anti-creep survives because the box is resolved from
 * a **selector** rather than stored as a rectangle — it is whatever that
 * element occupies, and it cannot grow to cover a neighbour.
 *
 * **That held across runs and not across elements**, which is a distinction
 * this comment used to elide (#651). A selector names a *set*, so every match
 * shared one path and `mergeBoxes` — whose rule is *two boxes naming one
 * element are one box* — unioned them. Two clocks on J23's ticket page became
 * a single box over the card between them. Each match now carries its own
 * path, so the sentence above is true of elements as well as of runs.
 *
 * **Adding to this list is a decision, not a convenience.** If the learner can
 * see it, let the learner find it.
 *
 * **And a marker is not always available** (#1459). A `<input type="date">`
 * that defaults to today is exactly the shape the second entry below describes
 * — a value moving once a day, invisible to a learner running two passes a
 * minute apart — and it cannot be marked: the attribute lands on the whole
 * control, 1.7% of the page against `MAX_DECLARED_BOX`, and the browser renders
 * the value in shadow DOM so there is no inner element to put it on.
 *
 * There the answer is for the **walk** to type a date rather than photograph a
 * default, and `defaulted-dates.test.ts` is what makes that discoverable
 * instead of folklore.
 */
export const DECLARED_VOLATILE: readonly DeclaredVolatile[] = [
  {
    selector: "[data-volatile-clock]",
    why: "the dashboard renders `now` truncated to the minute, which is coarser than the dwell window and finer than a run — the one value the learner cannot reliably see (#590)",
  },
  {
    selector: "[data-volatile-date]",
    why: "a rendered date moves once a **day**, and a learning pass is two runs a minute apart — so it agrees with itself every time and the baseline is red the next morning (#617). Marked at the render site, so every journey photographing that cell is masked without its author knowing the cell exists",
  },
  {
    selector: "[data-volatile-code]",
    why: "the sign-in code is issued fresh every run, so it can never be compared — and a *learned* mask over six digit slots covers only the ones that happened to differ between two passes. That is a partial mask over a wholly volatile value: it passes the run that learned it and goes red later on a slot nobody watched (#654)",
  },
];

/**
 * Where those regions are, on this page, right now.
 *
 * **One path per element, not per selector** (#651, #617).
 *
 * `mergeBoxes` keys on this and merges what shares it, on the premise that a
 * path names one element — true of `domBoxes`, which describes an element, and
 * false of a selector, which describes a *set*. Every match therefore shared a
 * name and was unioned into the rectangle containing all of them.
 *
 * **Found twice, independently and from opposite ends**, which is why the
 * measurements are both kept: one is a mask that looks plausible and one is a
 * mask that is obviously absurd, and only the second kind gets noticed.
 *
 * | | |
 * | --- | --- |
 * | two 76×24 stamps on J23's ticket detail became one **918×450** box over the card between them — **46.2%** of the page, refused by the 3% guard | #651 |
 * | the staff table's four `Since` cells became one 83×164 box across the gaps between rows, and the leases table's two date columns over seven rows became a single region at **3.0%** — exactly the cap | #617 |
 *
 * The ordinal is the element's position among the matches, which is stable
 * across the passes being compared because they run the same code against the
 * same seeded rows. It is **not** stable across a *product* change that adds a
 * clock above another — and that is the right behaviour: a mask must not
 * silently carry over to a different element.
 *
 * The tag keeps `diff.md` readable, so a reviewer can tell which clock a box is
 * without counting.
 */
export async function declaredVolatileBoxes(
  page: EvaluatingPage,
  declared: readonly DeclaredVolatile[] = DECLARED_VOLATILE,
): Promise<DomBox[]> {
  const selectors = declared.map((d) => d.selector);
  const raw = await page.evaluate((list) => {
    const out: RawRect[] = [];
    for (const selector of list) {
      const matches = [...document.querySelectorAll(selector)];
      for (const [index, element] of matches.entries()) {
        const r = element.getBoundingClientRect();
        // Page coordinates and outward rounding, both matching `domBoxes` —
        // the screenshot is `fullPage`, and the rounding is what makes this
        // box contain the dates inside it rather than nearly contain them
        // (#923).
        if (r.width > 0 && r.height > 0) {
          out.push({
            left: r.left + window.scrollX,
            top: r.top + window.scrollY,
            right: r.right + window.scrollX,
            bottom: r.bottom + window.scrollY,
            path: `declared:${element.tagName.toLowerCase()}${selector}[${index}]`,
          });
        }
      }
    }
    return out;
  }, selectors);
  // Rounded here rather than in the page: a `page.evaluate` receives data
  // and not functions, so a shared constructor cannot cross into it.
  return raw.map(({ left, top, right, bottom, ...rest }) => ({
    ...boxOf(left, top, right, bottom),
    ...rest,
  }));
}

/**
 * **Dates the page has rendered, whether or not anybody marked them.**
 *
 * `DECLARED_VOLATILE` above is the fix; this is the check that the fix was
 * applied. It is the half #617 could not get from a static scan of the
 * source: the formatting call and the element are routinely in different
 * files — `platform/staff/page.tsx` calls `toLocaleDateString` and
 * `staff-table.tsx` renders the string — so a source pattern check can ask
 * *did somebody declare this* and never *is the value covered*.
 * Read from the DOM, both questions are answerable, because an element has a
 * rectangle and so does a mask.
 *
 * **Every date in this product moves with the clock**, which is what makes a
 * blanket rule right rather than lazy: a row created by the run reads today, a
 * seeded row is dated relative to today (`packages/db/agents.md` requires it,
 * so "expiring in 45 days" stays true), and `now` is rendered outright. There
 * is no third kind to carve out.
 *
 * **Text nodes, and the matched characters within them.** A `Range` over the
 * match gives the rectangle of `14:03` rather than of the button reading *"Try
 * again at 14:03"* — so the coverage question stays *is the value excluded*
 * and never becomes *is the sentence around it excluded*. Walking text nodes
 * also avoids nominating `BODY` for every date on the page, which is the trap
 * `domBoxes` sidesteps one rule over.
 *
 * **Inputs fall out for free**, and that is the right answer rather than a
 * happy accident: a value typed *into* the wizard is the journey's own doing,
 * so it belongs to a step-level `mask` in the spec — the rule stated at
 * `leaseDates` in `j35-guided-setup.spec.ts`. A value is not text content, so
 * nothing here sees one.
 *
 * **The descriptor, never the text.** `describe` above refuses to read text
 * into a committed file because the volatile values are a sign-in code and a
 * tenant's address; a failure message here obeys the same rule, and names the
 * element and its rectangle.
 */
export async function dateBoxes(
  page: EvaluatingPage,
  shapes: readonly string[] = DATE_SHAPES,
): Promise<DomBox[]> {
  const raw = await page.evaluate((sources) => {
    // `DATE_SHAPES` below says what these are and why the list is short.
    // Global, because the rectangle wanted is the **run of characters** rather
    // than the element — see below.
    const SHAPES = sources.map((source) => new RegExp(source, "g"));

    const describe = (el: Element): string => {
      const testid = el.getAttribute("data-testid");
      if (testid) return `${el.tagName.toLowerCase()}[data-testid="${testid}"]`;
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
      const classes = (el.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("");
      return `${el.tagName.toLowerCase()}${classes}`;
    };

    const out: RawRect[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      const parent = node.parentElement;
      if (!parent) continue;
      for (const shape of SHAPES) {
        shape.lastIndex = 0;
        for (let hit = shape.exec(text); hit; hit = shape.exec(text)) {
          /*
           * **The characters, not the element that holds them.**
           *
           * A `Range` over the matched offsets gives the rectangle of
           * `14:03` alone. Taking the element instead would demand a mask over
           * the whole of *"Try again at 14:03"* — so the stable half of the
           * sentence would stop being compared, which is the creep this whole
           * file is written against. It also lets an element carry a date and
           * a paragraph of prose without the prose going ungated.
           */
          const range = document.createRange();
          range.setStart(node, hit.index);
          range.setEnd(node, hit.index + hit[0].length);
          const r = range.getBoundingClientRect();
          range.detach();
          if (r.width < 1 || r.height < 1) continue;
          // Rounded the same way as the element boxes above, which is what lets
          // a declared element cover the run of characters inside it (#923).
          out.push({
            left: r.left + window.scrollX,
            top: r.top + window.scrollY,
            right: r.right + window.scrollX,
            bottom: r.bottom + window.scrollY,
            path: describe(parent),
          });
        }
      }
    }
    return out;
  }, shapes);
  // Rounded here rather than in the page: a `page.evaluate` receives data
  // and not functions, so a shared constructor cannot cross into it.
  return raw.map(({ left, top, right, bottom, ...rest }) => ({
    ...boxOf(left, top, right, bottom),
    ...rest,
  }));
}

/**
 * The shapes a date takes **on this product's screens**.
 *
 * Sources rather than `RegExp`s, and passed *into* the page, because
 * `page.evaluate` serialises its function and cannot close over a module
 * constant. One declaration, reachable from a unit test — which is the half
 * that was missing: these lived inside the closure, so nothing could assert
 * what they match and the gap below went unnoticed until a recording was about
 * to break on it.
 *
 * | | |
 * | --- | --- |
 * | `2026-09-08` | ISO |
 * | `14:03` | a clock |
 * | `Sep 8, 2026` | `toLocaleDateString("en-US", { month: "short" })` |
 * | **`2026-09`** | **the period key** — `Charge.periodKey`, every statement URL, and six month chips on the owner's statements page computed from `new Date()` |
 *
 * The last was missing, and the list above is why: it was written from the
 * shapes a date can *take* rather than the shapes this product *prints*. J7 was
 * green the day it was recorded and would have gone red on the 1st — six
 * regions at once, on a journey nobody had touched.
 *
 * **`2026-09` is anchored on both sides**, so it cannot take the front off
 * `2026-09-13` and leave a box one character short of the `-13`; the full-date
 * shape already covers that case whole.
 *
 * Deliberately not every format a date can take: a pattern that also matched
 * `1 of 25` or a postcode would report the page as full of clocks, and a mask
 * that cries wolf is one people stop reading.
 */
export const DATE_SHAPES = [
  "\\d{4}-\\d{2}-\\d{2}",
  "\\b\\d{1,2}:\\d{2}\\b",
  "\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},\\s+\\d{4}\\b",
  "(?<!\\d)\\d{4}-\\d{2}(?![\\d-])",
] as const;

/** What the probe concluded about one declared volatile element. */
export type ReflowRisk = {
  /** The element that was probed — `declared:span[data-volatile-date][0]`. */
  volatile: string;
  /**
   * `varies` — its width changes across values its formatter can produce, and
   * other elements move with it. `unknown` — nothing here recognises the
   * value's shape, so the question was **not asked**.
   */
  verdict: "varies" | "unknown";
  /** The rendered text, for `unknown`. Never for `varies` — see below. */
  sample?: string;
  /** The widths observed, narrowest first. `varies` only. */
  widths?: number[];
  /** What moved. Capped and deduped. `varies` only. */
  moved?: string[];
  /** How many moved in total, since `moved` is capped. */
  total?: number;
};

/**
 * **Does this volatile value's *width* decide where anything else sits?**
 *
 * A mask covers a volatile value. It cannot cover what that value's width does
 * to everything around it — a table column is sized by its content, so a date
 * one character wider moves every column to its left, header included. Those
 * pixels are nowhere near the mask, they are a real difference, and the
 * comparison is right to report them.
 *
 * Measured on `J40 happy/01`, 2026-09-09 against 2026-09-11: **3,569 pixels
 * changed with the date fully masked**, every band starting at exactly `x=587`
 * and the header row among them. The only textual difference between the two
 * images was *"Sep 9"* against *"Sep 11"* (#774).
 *
 * ## The question has to be about *this formatter's* values
 *
 * The first version of this appended a character and asked whether anything
 * moved. That is a check that can only answer yes: a content-sized column grows
 * for **any** longer string, whether or not the real value is ever longer. It
 * reported all three of J40's dates as a risk *after* they had been fixed —
 * caught by running it against the fix and not believing the result.
 *
 * So a value is substituted with others **its own formatter could have
 * produced**: another ISO date for an ISO date, another day-of-month for a
 * locale date. `2026-09-11` and `2026-12-31` are the same width and the answer
 * is no; *"Sep 9, 2026"* and *"Sep 11, 2026"* are not and the answer is yes.
 *
 * ## Three answers, and the third is named
 *
 * A shape nothing here recognises is **`unknown`**, never a pass. Collapsing it
 * into *no risk* is the failure `agents.md` names first — a check reporting
 * confidently on a question it could not ask. The `unknown` list is the probe's
 * own backlog: each entry is a volatile value whose width nobody has
 * established, and the fix is a line in `PLAUSIBLE` rather than a bigger mask.
 *
 * **`sample` is set only for `unknown`**, deliberately. The text is what the
 * mask exists to keep out of committed files — `domBoxes` refuses to describe
 * an element by its text for that reason — and an unrecognised shape has to be
 * shown to somebody or it cannot be classified. A recognised one does not: its
 * shape is already named.
 *
 * ## What it does not ask
 *
 * Whether the *other* elements are ones a reader cares about. A `<td>` growing
 * around a wider date is the layout working, so ancestors and descendants are
 * excluded; a sibling moving is the finding, because that is a region no mask
 * covers or should.
 *
 * And it only sees what is **declared**. An undeclared volatile value is
 * `uncoveredDates`' job, one rule over.
 *
 * The DOM is restored before it returns, and this runs only on a learning pass
 * — after the screenshot, so nothing it touches is photographed.
 */
export async function reflowRisks(
  page: EvaluatingPage,
  declared: readonly DeclaredVolatile[] = DECLARED_VOLATILE,
): Promise<ReflowRisk[]> {
  const selectors = declared.map((d) => d.selector);
  return page.evaluate((list) => {
    const SKIP = new Set(["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "META", "LINK", "TITLE"]);
    const describe = (el: Element): string => {
      const testid = el.getAttribute("data-testid");
      if (testid) return `${el.tagName.toLowerCase()}[data-testid="${testid}"]`;
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
      const classes = (el.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("");
      return `${el.tagName.toLowerCase()}${classes}`;
    };

    /**
     * Other renderings the same formatter could have produced.
     *
     * Each entry spans the widest and narrowest the format reaches: a
     * day-of-month that is one digit and two, a month whose name is short and
     * long, digits that differ in a font without tabular figures. `[]` means
     * *this shape is not recognised*, which the caller reports rather than
     * treats as safe.
     */
    /**
     * Other renderings the same formatter could have produced.
     *
     * Matched **anywhere in the text, not only as the whole of it**, and the
     * substitution replaces the matched run — so `"As of 2026-09-11 11:38 UTC"`
     * and `"expires 2026-09-18T11:41:12.320Z"` are both answerable without an
     * entry per surrounding sentence. Both were `unknown` on the first real run
     * across every journey, which is what this ordering exists to handle.
     *
     * **Longest shape first.** An ISO date matches inside an ISO instant, so
     * testing the short one first would substitute a *date* into a timestamp
     * and measure a width the formatter never produces.
     *
     * Each entry spans the widest and narrowest the format reaches: a
     * day-of-month of one digit and of two, a month name at each end of the
     * alphabet, digits that differ in a font without tabular figures.
     */
    const PLAUSIBLE: Array<{ shape: RegExp; values: string[] }> = [
      // `2026-09-18T11:41:12.320Z` — a raw instant, fixed length.
      {
        shape: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
        values: ["2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z"],
      },
      // `2026-09-11 11:38 UTC`, the dashboard clock, with or without a prefix.
      {
        shape: /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?( UTC)?/,
        values: ["2026-01-01 00:00 UTC", "2026-12-31 23:59 UTC"],
      },
      // `Sep 9, 2026` against `Sep 11, 2026` — the one that bit (#774).
      {
        shape: /[A-Z][a-z]{2} \d{1,2}, \d{4}/,
        values: ["May 1, 2026", "Sep 11, 2026", "Dec 30, 2026"],
      },
      // `2026-09-11` — fixed length by construction, so this asks only whether
      // the digits are equal-width in this font. Measured: they are.
      { shape: /\d{4}-\d{2}-\d{2}/, values: ["2026-01-01", "2026-12-31", "2026-08-18"] },
      /*
       * `2026-09` — the period key, and fixed length for the same reason.
       *
       * The **second** place this format was missing. `DATE_SHAPES` could not
       * see it either, so an owner's statements page rendered six month chips
       * computed from `new Date()` that nothing masked and nothing reported —
       * and marking them then failed here instead, which is the pair of lists
       * working as designed: one finds an undeclared date, the other asks
       * whether declaring it is safe.
       */
      { shape: /^\d{4}-\d{2}$/, values: ["2026-01", "2026-12", "2026-09"] },
      // `14:32`, a clock on its own.
      { shape: /^\d{1,2}:\d{2}(:\d{2})?$/, values: ["00:00", "23:59", "9:05"] },
      // `3 days ago`, `just now`, `in 2 months` — genuinely variable, and the
      // next instance of this if one ever lands on a compared table.
      { shape: /^(in .+|.+ ago|just now)$/, values: ["just now", "in 2 months", "11 days ago"] },
      // A six-digit sign-in code. Always six digits, so only the glyphs vary.
      { shape: /^\d{6}$/, values: ["000000", "111111", "890123"] },
    ];

    const everything = () =>
      [...document.querySelectorAll("*")].filter((el) => !SKIP.has(el.tagName));
    const geometry = (els: Element[]) =>
      new Map(
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return [el, `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`] as const;
        }),
      );

    const risks: ReturnType<() => ReflowRisk[]> = [] as never;

    for (const selector of list) {
      for (const [index, el] of [...document.querySelectorAll(selector)].entries()) {
        const name = `declared:${el.tagName.toLowerCase()}${selector}[${index}]`;
        /*
         * Only an element whose children are all text. Appending to anything
         * else rewrites real structure, and restoring it from a string is not
         * the same DOM.
         */
        const textOnly = [...el.childNodes].every((n) => n.nodeType === Node.TEXT_NODE);
        /*
         * **`raw` is what gets put back; `before` is only what gets matched.**
         *
         * Restoring the *trimmed* text is a silent edit: an element whose JSX
         * left whitespace around the value comes back a character shorter, for
         * the rest of the test, and every later step photographs a page this
         * probe quietly changed. A mutation that does not announce itself is
         * the whole failure mode this file exists to catch, and writing it into
         * the catcher would have been the third instance in one afternoon.
         */
        const raw = el.textContent ?? "";
        const before = raw.trim();
        if (!textOnly || before === "") continue;

        const known = PLAUSIBLE.find((p) => p.shape.test(before));
        if (!known) {
          risks.push({ volatile: name, verdict: "unknown", sample: before });
          continue;
        }

        /*
         * **The element's own width first, and the page only if it varies.**
         *
         * The sweep below reads a rectangle for every element on the page, and
         * `getBoundingClientRect` forces layout — so doing it once per
         * substituted value, per declared element, per step, is the difference
         * between a learning pass that finishes and one that blows the step
         * budget. Measured by writing it the expensive way first: J35's steps
         * started erroring on a full run, and **a red pass still writes
         * masks**, so a slow probe does not merely cost time — it poisons the
         * thing it is meant to protect.
         *
         * The early exit is sound rather than a shortcut: a width that never
         * changes cannot move anything, so the page sweep has nothing to find.
         * `varies` requires both halves anyway.
         */
        const widths = new Set<number>();
        for (const value of known.values) {
          // The matched run, not the whole text — so a prefix like `As of ` or
          // `expires ` survives and the width measured is the real one.
          el.textContent = before.replace(known.shape, value);
          widths.add(Math.round(el.getBoundingClientRect().width));
        }
        el.textContent = raw;
        if (widths.size <= 1) continue;

        const others = everything().filter((other) => other !== el);
        const was = geometry(others);
        const moved = new Set<Element>();
        for (const value of known.values) {
          el.textContent = before.replace(known.shape, value);
          const now = geometry(others);
          for (const other of others) {
            if (
              was.get(other) !== now.get(other) &&
              // An ancestor growing around a wider child is the layout working.
              !other.contains(el) &&
              !el.contains(other)
            ) {
              moved.add(other);
            }
          }
        }
        el.textContent = raw;

        // Both halves are required. A width that varies inside a fixed-width
        // container moves nothing and is not a finding; elements moving with
        // no width change is not this rule at all.
        if (moved.size > 0) {
          risks.push({
            volatile: name,
            verdict: "varies",
            widths: [...widths].sort((a, b) => a - b),
            moved: [...new Set([...moved].map(describe))].slice(0, 6),
            total: moved.size,
          });
        }
      }
    }
    return risks;
  }, selectors);
}
