/**
 * **A journey, recorded as something a person can read.**
 *
 * QA tests journeys — a sequence a person performs — so the thing worth
 * asserting is not a set of DOM nodes but whether somebody can get something
 * done. A passing spec proves the steps ran; it says nothing about what the
 * person saw on the way, which is the half a reviewer needs. So every step
 * writes three things at once: a screenshot, a line of narrative, and whatever
 * the step captured — an email, a document, a refusal.
 *
 * ## The rules it enforces
 *
 * - **A step with no assertion is not a step.** `step()` takes the action and
 *   its assertion together, so neither can be written without the other.
 * - **An error path is a path.** Each gets its own folder, so "what happens
 *   when it is wrong" sits beside "what happens when it is right".
 * - **Written by the run, never by hand**, and **after every step** — a journey
 *   that broke at step 3 is the one somebody most needs to look at.
 * - **Every step is compared** against the committed screenshot, under a mask of
 *   what two runs of unchanged software disagreed about. Soft, so a red step
 *   does not stop the recording a reviewer was asked to look at.
 * - **Nothing is deleted.** Each step overwrites its own files and nothing else,
 *   so a run that dies early cannot eat recordings it never reached (door_nexa
 *   lost 65 files once to a wipe-first recorder).
 *
 * ## The modes, set by `journeys learn` through the environment
 *
 * | variable | |
 * | --- | --- |
 * | `JOURNEY_MASKS=1` | a learning pass: masks are written, nothing is gated |
 * | `JOURNEY_MASK_RECORD=1` | pass 1: **match, do not learn** — see below |
 * | `JOURNEY_RELEARN=1` | start each step's mask from nothing |
 * | `JOURNEY_DWELL=<ms>` | the timed motion watch, for an audit run; 0 by default |
 *
 * **Pass 1 matches; it does not learn** (door_nexa #718). Its baseline is the
 * *committed* recording, which after a UI change is a different build — learning
 * there teaches the mask the change just made. A step that matches keeps the
 * committed image; one that does not becomes the reference pass 2 learns
 * against, where both sides are the same build.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { PNG } from "pngjs";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import type { JourneysConfig } from "../config.mts";
import {
  MASK_VERSION,
  MAX_DECLARED_BOX,
  MAX_STEP_COVERAGE,
  classifyMotion,
  compareMasked,
  drawDiff,
  drawMask,
  exercisedBy,
  mergeBoxes,
  refreshDeclared,
  uncoveredDates,
  verifyStored,
  volatileBoxes,
  writeMaskEvidence,
} from "../mask/boxes.mts";
import type { DomBox, MaskBox } from "../mask/boxes.mts";
import { dateBoxes, declaredVolatileBoxes, domBoxes, reflowRisks } from "../mask/dom.mts";
import { assertPersona, assertTitle, journeyFolder, personaLabel } from "../registry.mts";
import { pdfDateBoxes, pdfPageImages, resolvePdfjs } from "../render/pdf.mts";
import { readStackStamp } from "../stack/stamp.mts";
import type { StackStamp } from "../stack/stamp.mts";
import { renderPath, runJson, stepStem, writePersonaMarker } from "./evidence.mts";
import type { Capture, Masked, StepRecord, StepVerdict } from "./evidence.mts";
import {
  growToContent,
  hideForScreenshot,
  readMutations,
  waitForSettled,
  watchMutations,
} from "./settle.mts";

export type { Capture } from "./evidence.mts";

export type JourneyMeta = {
  /** `J4`, and it must be in the registry. */
  id: string;
  /** The registry's title, exactly — a second spelling writes a second folder. */
  title: string;
  /** The path within the journey: `happy`, `wrong-code`. */
  path: string;
  /** One sentence: what a person is trying to do. */
  intent: string;
  /**
   * The persona key whose walk this is — a registry persona, or `common` for a
   * walk that does not depend on who performs it. **Every recording carries the
   * level**: door_nexa made it opt-in, and two personas in one folder then
   * merged their screenshots clean while their READMEs conflicted.
   */
  persona: string;
};

export type StepOptions = {
  /**
   * Regions painted over before the screenshot. Rarely needed: the mask is
   * learned. This is for what varies by *environment* rather than by run, and
   * for a value the **journey typed** — a date the walk entered, say.
   */
  mask?: Locator[];
};

/** What a recorder needs that is not the page: the config, its root, the stack it ran on. */
export type JourneyContext = { root: string; config: JourneysConfig; stack: StackStamp };

let cached: Promise<JourneyContext> | undefined;

/** The context for this process — read once, shared by every journey in a worker. */
export function journeyContext(): Promise<JourneyContext> {
  return (cached ??= (async () => {
    const root = journeysRoot();
    const config = await loadJourneysConfig(root);
    return { root, config, stack: readStackStamp(join(root, config.scratchRoot)) };
  })());
}

/** A second's wait before the one re-shot a large gap earns. */
const GLITCH_SETTLE = 1_000;
/** The second gap must be under half the first to call the first a glitch. */
const GLITCH_SHRINK = 0.5;

const readMask = (file: string): { version?: number; boxes: MaskBox[] } | undefined =>
  existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { version?: number; boxes: MaskBox[] })
    : undefined;

const writeMask = (file: string, boxes: readonly MaskBox[]) =>
  writeFileSync(file, JSON.stringify({ version: MASK_VERSION, boxes }, null, 2) + "\n");

const asDeclared = (boxes: readonly DomBox[]): MaskBox[] =>
  boxes.map((b) => ({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    from: b.path,
    provenance: "declared" as const,
  }));

export class Journey {
  /** A capture that is not a screenshot: page text, a JSON refusal. */
  static capture(label: string, body: string, language = "text"): Capture {
    return { kind: "text", label, language, body };
  }

  /** Markup to render and screenshot — an email as it lands. */
  static rendered(label: string, html: string): Capture {
    return { kind: "html", label, html };
  }

  /**
   * A file the product produced. Give it the name the recipient sees. A PDF is
   * also rendered page by page and gated; anything else is linked.
   */
  static file(
    label: string,
    filename: string,
    bytes: Uint8Array,
    volatile: readonly string[] = [],
  ): Capture {
    return { kind: "file", label, filename, bytes, volatile };
  }

  /** A PNG the step computed — a diff, a composite. Shown and gated. */
  static image(label: string, png: Uint8Array): Capture {
    return { kind: "image", label, png };
  }

  /** The usual way in: reads the config, the registry and the stack stamp. */
  static async open(page: Page, meta: JourneyMeta, info?: TestInfo): Promise<Journey> {
    return new Journey(page, meta, await journeyContext(), info);
  }

  private readonly page: Page;
  private readonly meta: JourneyMeta;
  private readonly context: JourneyContext;
  /** Kept for spec authors who pass it; Playwright's own diff images are not used. */
  readonly info: TestInfo | undefined;
  private readonly steps: StepRecord[] = [];
  /** `<evidence>/<id>-<slug>/<persona>`. */
  private readonly dir: string;
  /** `<dir>/<path>/snapshots` — images apart from the narrative, so the README is findable. */
  private readonly shots: string;
  /** The committed screenshots, copied aside before this run overwrites them. */
  private readonly baseline: string;
  private n = 0;
  /** The walk, not the test: browser launch and fixtures are outside it. */
  private readonly startedAt = Date.now();
  /** How many screenshots found a hidden selector at all — zero across a walk is the finding. */
  private hiddenSeen = 0;
  /** Every pathname this walk reached, in visit order, deduplicated — `run.json`'s `visited`. */
  private readonly visited = new Set<string>();
  private pdfjs: string | undefined;
  private readonly learning: boolean;
  private readonly recordOnly: boolean;
  private readonly relearn: boolean;
  private readonly dwell: number;

  constructor(page: Page, meta: JourneyMeta, context: JourneyContext, info?: TestInfo) {
    this.page = page;
    this.meta = meta;
    this.context = context;
    this.info = info;
    this.learning = process.env.JOURNEY_MASKS === "1";
    this.recordOnly = process.env.JOURNEY_MASK_RECORD === "1";
    this.relearn = process.env.JOURNEY_RELEARN === "1";
    this.dwell = Number(process.env.JOURNEY_DWELL ?? 0);

    const { registry, evidenceRoot, scratchRoot } = context.config;
    const journey = assertTitle(registry, meta.id, meta.title);
    assertPersona(registry, journey, meta.persona);

    /*
     * **Observe the browser, not the spec.** A walk that reaches a page by
     * clicking counts exactly like one that calls `goto` — which is the whole
     * reason this is not a search of the source. Both events, because each is
     * blind to half: `framenavigated` misses a route requested and refused,
     * `request` misses a client-side navigation.
     */
    const note = (raw: string) => {
      try {
        const url = new URL(raw);
        if (url.protocol === "http:" || url.protocol === "https:") this.visited.add(url.pathname);
      } catch {
        // Not a route. Silent: this is bookkeeping beside a test and must never fail it.
      }
    };
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        note(request.url());
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) note(frame.url());
    });

    this.dir = join(context.root, evidenceRoot, journeyFolder(meta.id, meta.title), meta.persona);
    this.shots = join(this.dir, meta.path, "snapshots");
    this.baseline = join(
      context.root,
      scratchRoot,
      "journey-baseline",
      meta.id,
      meta.persona,
      meta.path,
    );
    rmSync(this.baseline, { recursive: true, force: true });
    if (existsSync(this.shots)) cpSync(this.shots, this.baseline, { recursive: true });
    mkdirSync(this.shots, { recursive: true });
    writePersonaMarker(this.dir, meta.persona, personaLabel(registry, meta.persona));
  }

  /**
   * One thing the person did, and what they then saw. `act` performs the
   * interaction **and** asserts the outcome.
   */
  async step(
    title: string,
    note: string,
    act: () => Promise<Capture[] | void>,
    options: StepOptions = {},
  ): Promise<void> {
    let captures: Capture[] = [];
    let failure: unknown;
    try {
      captures = (await act()) || [];
    } catch (error) {
      // Recorded, then rethrown: the screenshot of the page as it broke is the
      // most useful image in the folder.
      failure = error;
    }
    this.n += 1;
    const stem = stepStem(this.n, title);
    const shot = `${stem}.png`;
    const rendered = await this.renderCaptures(captures);
    const files = await this.keepFiles(captures, rendered);

    const { config } = this.context;
    const settle = config.settle;
    let settling: MaskBox[] = [];
    let verdict: StepVerdict = "not compared";
    let diff: StepRecord["diff"];
    let masked: Masked | undefined;

    await waitForSettled(this.page, settle);
    const restore = await growToContent(this.page, settle);
    const hidden = await hideForScreenshot(this.page, settle);
    if (hidden.found > 0) this.hiddenSeen += 1;
    if (hidden.painting.length > 0) {
      console.warn(
        `\n  ${this.meta.path} step ${this.n}: a hidden selector is still painting ` +
          `(${hidden.painting.join(", ")}) with the hide rule applied, so it is in this screenshot.`,
      );
    }
    await watchMutations(this.page);

    const here = join(this.shots, shot);
    const wasHere = join(this.baseline, shot);
    const maskFile = join(this.shots, `${shot}.mask.json`);
    const shoot = (to: string) =>
      this.page.screenshot({
        path: to,
        fullPage: true,
        // Not "hide": Playwright would write a style onto every input, which React
        // then hydrates against. The caret is hidden by stylesheet instead.
        caret: "initial",
        animations: "disabled",
        ...(options.mask ? { mask: options.mask } : {}),
      });
    await shoot(here);

    const arriving = await readMutations(this.page);
    if (arriving.length > 0) {
      console.warn(
        `\n  ${this.meta.path} step ${this.n}: the page was still changing while it was ` +
          `photographed — ${arriving.join(", ")}.\n  The answer is a wait condition on this ` +
          "step (settle.selectors), not a mask.",
      );
    }
    await restore();

    // Read at the instant of the screenshot: a step that ends by clicking has
    // navigated by the time a mask is known.
    const dates = await dateBoxes(this.page, config.dateShapes);

    if (existsSync(wasHere)) {
      if (this.learning && failure) {
        /*
         * **Nothing is learned from a step that broke.** Its screenshot is a
         * page that did not work, so diffing it is not "what varies between two
         * runs" — it is a page-sized box, permanent by union. The steps before
         * the failure are real and still learn.
         */
      } else if (this.learning) {
        let dom = await domBoxes(this.page);
        let declared = await declaredVolatileBoxes(this.page, config.declaredVolatile);

        /*
         * **A big gap gets one second opinion, a second later — pass 2 only.**
         * A glitch learned here is permanent; a gap that closes on its own is a
         * missing wait condition. Pass 1's gap is *supposed* to be large after a
         * UI change, so it gets no retry.
         */
        if (!this.recordOnly) {
          const gapOf = () => {
            const answer = compareMasked(wasHere, here, declared);
            return answer.kind === "changed" ? answer.ratio : 0;
          };
          const before = gapOf();
          if (before >= MAX_STEP_COVERAGE) {
            await this.page.waitForTimeout(GLITCH_SETTLE);
            await shoot(here);
            dom = await domBoxes(this.page);
            declared = await declaredVolatileBoxes(this.page, config.declaredVolatile);
            const after = gapOf();
            if (after < before * GLITCH_SHRINK) {
              console.warn(
                `\n  ${this.meta.path} step ${this.n}: the first capture was racing — ` +
                  `${(before * 100).toFixed(1)}% differed, ${(after * 100).toFixed(1)}% a second ` +
                  "later. The second shot is recorded. That is a missing wait condition, not a mask.",
              );
            }
          }
        }

        this.reportReflow(await reflowRisks(this.page, config.declaredVolatile));
        const motion = await this.watchForMotion(dom);
        settling = motion.settling;

        const found: MaskBox[] = [
          ...(this.recordOnly
            ? []
            : (volatileBoxes(wasHere, here, dom) ?? []).map((b) => ({
                ...b,
                provenance: "learned" as const,
              }))),
          ...(this.recordOnly
            ? []
            : motion.ticking.map((b) => ({ ...b, provenance: "learned" as const }))),
          ...asDeclared(declared),
        ];
        const stored = readMask(maskFile);
        // A stored box from an older rule is relearned, never unioned: the looser
        // rule would otherwise win for ever.
        const carried = this.relearn || stored?.version !== MASK_VERSION ? [] : stored.boxes;
        // Both enumerations: a stored declared box carries the declared spelling,
        // which a DOM walk never produces.
        const { kept, dropped } = verifyStored(carried, [...dom, ...declared]);
        if (dropped.length > 0) {
          console.warn(
            `[mask] ${this.meta.path}/${shot}: dropped ${dropped.length} stored box(es) whose path ` +
              `no longer names the same element — ${dropped.map((b) => b.from).join(", ")}.`,
          );
        }
        const boxes = mergeBoxes([...kept, ...found]);
        writeMask(maskFile, boxes);

        const overlay = `${stem}-mask.png`;
        const coverage = drawMask(here, boxes, join(this.shots, overlay));
        const widestDeclared = this.widestDeclared(here, boxes);
        if (coverage > MAX_STEP_COVERAGE || widestDeclared > MAX_DECLARED_BOX) {
          // Taken before the restore below: afterwards both files are the same bytes.
          const evidence = writeMaskEvidence(
            wasHere,
            here,
            join(
              this.context.root,
              config.scratchRoot,
              "mask-evidence",
              relative(join(this.context.root, config.evidenceRoot), this.dir),
              this.meta.path,
              stem,
            ),
          );
          console.warn(
            `\n[mask] ${this.meta.path}/${shot} is over a threshold — ${(coverage * 100).toFixed(1)}% ` +
              `hidden, widest declared box ${(widestDeclared * 100).toFixed(1)}%.\n` +
              `  The two passes it was learned from, and their diff: ${evidence}\n`,
          );
        }
        // Every pass hands the committed image forward when it still matches, so
        // a re-record's diff is exactly the steps that changed.
        if (compareMasked(wasHere, here, boxes).kind === "same") copyFileSync(wasHere, here);
        masked = { boxes, coverage, file: overlay };
      } else if (existsSync(maskFile)) {
        const stored = readMask(maskFile)!.boxes;
        // Declared boxes re-measured on every comparison: a date one character
        // wider than the day it was recorded sits outside yesterday's box.
        const boxes = refreshDeclared(
          stored,
          await declaredVolatileBoxes(this.page, config.declaredVolatile),
        );
        const answer = compareMasked(wasHere, here, boxes);
        if (answer.kind !== "same") {
          verdict = "changed";
          diff = this.carryOwnDiff(wasHere, here, stem, boxes);
          expect
            .soft(
              answer.kind === "resized" ? `${answer.was} → ${answer.now}` : answer.pixels,
              `${this.meta.path}/${shot} changed outside its mask`,
            )
            .toBe(answer.kind === "resized" ? answer.was : 0);
        } else {
          verdict = "unchanged";
          // Before the copy — afterwards an unmasked comparison is `same` for ever
          // and no declared box could ever be credited.
          if (boxes.length > 0 && compareMasked(wasHere, here, []).kind !== "same") {
            this.creditExercised(maskFile, stored, exercisedBy(wasHere, here, boxes));
          }
          // A passing comparison writes nothing: the committed pixels stay.
          copyFileSync(wasHere, here);
        }
        const overlay = `${stem}-mask.png`;
        masked = {
          boxes,
          coverage: drawMask(here, boxes, join(this.shots, overlay)),
          file: overlay,
        };
      }
    }

    /*
     * **Every date on the page is masked, or this step is red tomorrow.** The
     * learner is two runs a minute apart and agrees with itself about anything
     * that moves once a day; its silence about a date is its blind spot. The
     * fix: `data-volatile-date` at the render site, or `mask` on the step if
     * the journey typed the value.
     */
    if (masked) {
      const uncovered = uncoveredDates(dates, masked.boxes);
      expect
        .soft(
          uncovered.map((b) => `${b.path} ${b.width}×${b.height} at ${b.x},${b.y}`),
          `${this.meta.path}/${shot} renders a date that nothing masks. Mark the render site ` +
            "`data-volatile-date`, or mask it at the step if this journey typed it.",
        )
        .toEqual([]);
    }

    // Evidence of a failure that no longer happens is worse than none.
    if (verdict !== "changed") this.dropOwnDiff(stem);

    this.steps.push({
      n: this.n,
      title,
      note,
      shot,
      captures,
      rendered,
      files,
      verdict,
      ...(diff ? { diff } : {}),
      ...(masked ? { masked } : {}),
      settling,
      failed: Boolean(failure),
    });

    this.write();
    if (failure) throw failure;
  }

  /** Render every `html` and `image` capture into the snapshots, gated like a step. */
  private async renderCaptures(captures: readonly Capture[]): Promise<StepRecord["rendered"]> {
    const rendered: StepRecord["rendered"] = [];
    for (const capture of captures) {
      if (capture.kind === "html") {
        // `.render.png`, so it is told apart from a step's screenshot. 680×200:
        // a short viewport lets the shot shrink to the card and grow for a long one.
        const file = `${stepStem(this.n, capture.label)}.render.png`;
        const sheet = await this.page.context().newPage();
        await sheet.setViewportSize({ width: 680, height: 200 });
        await sheet.setContent(capture.html, { waitUntil: "load" });
        await sheet.screenshot({ path: join(this.shots, file), fullPage: true });
        // Asked of the sheet, before it closes: the journey's page is not in this image.
        const dom = this.learning ? await domBoxes(sheet) : [];
        await sheet.close();
        rendered.push({ label: capture.label, file, ...this.maskedOf(this.gateRender(file, dom)) });
      } else if (capture.kind === "image") {
        const file = `${stepStem(this.n, capture.label)}.render.png`;
        writeFileSync(join(this.shots, file), capture.png);
        rendered.push({ label: capture.label, file, ...this.maskedOf(this.gateRender(file, [])) });
      }
    }
    return rendered;
  }

  private maskedOf(masked: Masked | undefined): { masked?: Masked } {
    return masked ? { masked } : {};
  }

  /** Keep each `file` capture whole, and render a PDF page by page into `rendered`. */
  private async keepFiles(
    captures: readonly Capture[],
    rendered: StepRecord["rendered"],
  ): Promise<StepRecord["files"]> {
    const files: StepRecord["files"] = [];
    for (const capture of captures) {
      if (capture.kind !== "file") continue;
      const stem = stepStem(this.n, capture.label);
      const kept = `${stem}-${capture.filename}`;
      mkdirSync(join(this.dir, this.meta.path, "files"), { recursive: true });
      writeFileSync(join(this.dir, this.meta.path, "files", kept), capture.bytes);
      files.push({ label: capture.label, filename: capture.filename, href: `files/${kept}` });
      if (!capture.filename.toLowerCase().endsWith(".pdf")) continue;

      this.pdfjs ??= resolvePdfjs(this.context.root, this.context.config.pdfjsFrom);
      const sheet = await this.page.context().newPage();
      const pages = await pdfPageImages(sheet, capture.bytes, this.pdfjs);
      const dates = await pdfDateBoxes(sheet, capture.bytes, this.pdfjs, {
        shapes: this.context.config.dateShapes,
        declared: capture.volatile ?? [],
      });
      for (const [i, png] of pages.entries()) {
        const file = `${stem}-p${i + 1}.render.png`;
        writeFileSync(join(this.shots, file), png);
        rendered.push({
          label:
            pages.length === 1
              ? capture.label
              : `${capture.label} — page ${i + 1} of ${pages.length}`,
          file,
          ...this.maskedOf(this.gateRender(file, [], dates[i] ?? [])),
        });
      }
      await sheet.close();
    }
    return files;
  }

  /**
   * Gate a rendered capture the way a step is gated. The same rules — pass 1
   * matches and does not learn, a passing comparison keeps the committed bytes,
   * declared boxes are re-measured — minus what a static render cannot have:
   * motion and a page that errored.
   */
  private gateRender(
    file: string,
    dom: readonly DomBox[],
    declared: readonly DomBox[] = [],
  ): Masked | undefined {
    const here = join(this.shots, file);
    const wasHere = join(this.baseline, file);
    const maskFile = join(this.shots, `${file}.mask.json`);
    if (!existsSync(wasHere)) return undefined;
    const overlay = `${file.replace(/\.png$/, "")}-mask.png`;
    const stored = readMask(maskFile);

    if (this.learning) {
      const carried = this.relearn || stored?.version !== MASK_VERSION ? [] : (stored?.boxes ?? []);
      const { kept } = verifyStored(carried, [...dom, ...declared]);
      const boxes = mergeBoxes([
        ...kept,
        ...asDeclared(declared),
        ...(this.recordOnly ? [] : (volatileBoxes(wasHere, here, dom) ?? [])),
      ]);
      writeMask(maskFile, boxes);
      if (compareMasked(wasHere, here, boxes).kind === "same") copyFileSync(wasHere, here);
      return { boxes, coverage: drawMask(here, boxes, join(this.shots, overlay)), file: overlay };
    }

    if (!stored) return undefined;
    const gate = refreshDeclared(stored.boxes, declared);
    const answer = compareMasked(wasHere, here, gate);
    if (answer.kind === "same") copyFileSync(wasHere, here);
    else {
      expect
        .soft(
          answer.kind === "resized" ? `${answer.was} → ${answer.now}` : answer.pixels,
          `${this.meta.path}/${file} changed outside its mask`,
        )
        .toBe(answer.kind === "resized" ? answer.was : 0);
    }
    return {
      boxes: gate,
      coverage: drawMask(here, gate, join(this.shots, overlay)),
      file: overlay,
    };
  }

  /** Before, after and the pixels between, beside the recording rather than in scratch. */
  private carryOwnDiff(before: string, after: string, stem: string, mask: readonly MaskBox[]) {
    const into = join(this.shots, "changed");
    mkdirSync(into, { recursive: true });
    copyFileSync(before, join(into, `${stem}-expected.png`));
    copyFileSync(after, join(into, `${stem}-actual.png`));
    const painted = drawDiff(before, after, mask, join(into, `${stem}-diff.png`));
    return {
      expected: `snapshots/changed/${stem}-expected.png`,
      actual: `snapshots/changed/${stem}-actual.png`,
      // A resize is not paintable pixel for pixel, and says so by being empty.
      diff: painted === null ? "" : `snapshots/changed/${stem}-diff.png`,
    };
  }

  /** The counterpart: this step's `changed/` images go once it is no longer red. */
  private dropOwnDiff(stem: string): void {
    const into = join(this.shots, "changed");
    for (const suffix of ["expected", "actual", "diff"]) {
      rmSync(join(into, `${stem}-${suffix}.png`), { force: true });
    }
    if (existsSync(into) && readdirSync(into).length === 0) rmSync(into, { recursive: true });
  }

  /**
   * Stamp declared boxes that just absorbed a real difference. Written back
   * only when a stamp changes — a counter bumped every pass would churn every
   * mask file on every run, breaking "a passing comparison writes nothing".
   * `stored`, never the refreshed union, which would make a widening permanent.
   */
  private creditExercised(
    maskFile: string,
    stored: readonly MaskBox[],
    did: readonly MaskBox[],
  ): void {
    const today = new Date().toISOString().slice(0, 10);
    const names = new Set(did.map((b) => b.from));
    let moved = false;
    const updated = stored.map((box) => {
      if (!names.has(box.from) || box.exercised === today) return box;
      moved = true;
      return { ...box, exercised: today };
    });
    if (moved) writeMask(maskFile, updated);
  }

  private widestDeclared(image: string, boxes: readonly MaskBox[]): number {
    const declared = boxes.filter((b) => b.provenance === "declared");
    if (declared.length === 0) return 0;
    const { width, height } = PNG.sync.read(readFileSync(image));
    return Math.max(...declared.map((b) => (b.width * b.height) / (width * height)));
  }

  /** A volatile value whose width moves its neighbours: a mask cannot cover that. */
  private reportReflow(risks: Awaited<ReturnType<typeof reflowRisks>>): void {
    const varies = risks.filter((r) => r.verdict === "varies");
    const unknown = risks.filter((r) => r.verdict === "unknown");
    if (varies.length > 0) {
      console.warn(
        `\n  ${this.meta.path} step ${this.n}: ${varies.length} volatile value(s) whose width moves ` +
          "other elements — a mask cannot cover this. Render it at a fixed width.\n" +
          varies
            .map(
              (r) =>
                `    ${r.volatile} — ${r.widths?.join("px, ")}px → ${r.total} moved: ${r.moved?.join(", ")}`,
            )
            .join("\n"),
      );
    }
    if (unknown.length > 0) {
      console.warn(
        `\n  ${this.meta.path} step ${this.n}: ${unknown.length} volatile value(s) of a shape ` +
          "the reflow probe does not recognise, so their width was not checked.\n" +
          unknown.map((r) => `    ${r.volatile} — ${JSON.stringify(r.sample)}`).join("\n"),
      );
    }
  }

  /**
   * The timed motion watch — off unless `JOURNEY_DWELL` is set (an audit run).
   * Three shots, because two can only say *something moved* and what has to be
   * decided is whether it is **still** moving: a clock versus a page arriving.
   * Its own temp directory per call, outside the repository.
   */
  private async watchForMotion(
    dom: readonly DomBox[],
  ): Promise<{ ticking: MaskBox[]; settling: MaskBox[] }> {
    if (this.dwell <= 0) return { ticking: [], settling: [] };
    const scratch = mkdtempSync(join(tmpdir(), "journey-motion-"));
    const at = (k: number) => join(scratch, `${this.n}-${k}.png`);
    const shoot = (to: string) =>
      this.page.screenshot({ path: to, fullPage: true, caret: "initial", animations: "disabled" });
    await shoot(at(0));
    await this.page.waitForTimeout(this.dwell);
    await shoot(at(1));
    await this.page.waitForTimeout(this.dwell);
    await shoot(at(2));
    const first = volatileBoxes(at(0), at(1), dom) ?? [];
    const second = volatileBoxes(at(1), at(2), dom) ?? [];
    rmSync(scratch, { recursive: true, force: true });
    const answer = classifyMotion(first, second);
    if (answer.settling.length > 0) {
      console.warn(
        `\n  ${this.meta.path} step ${this.n}: ${answer.settling.length} region(s) were still ` +
          `arriving ${this.dwell}ms after the screenshot and had stopped by ${2 * this.dwell}ms. ` +
          "Not masked — this step is racing its own page.\n" +
          answer.settling.map((b) => `    ${b.from}`).join("\n"),
      );
    }
    return answer;
  }

  /** Write the narrative, the verification page and `run.json`. Called after every step. */
  write(): string {
    const { config, stack } = this.context;
    if (
      stack.devOverlayPossible &&
      config.settle.hide.length > 0 &&
      this.steps.length > 0 &&
      this.hiddenSeen === 0
    ) {
      console.warn(
        `\n  ${this.meta.path}: no hidden selector (${config.settle.hide.join(", ")}) was found on any ` +
          `of ${this.steps.length} screenshot(s). On a stack that can show framework chrome, a hide ` +
          "rule matching nothing is a no-op — the next badge lands in these images.",
      );
    }
    const { readme, diff } = renderPath(
      {
        id: this.meta.id,
        title: this.meta.title,
        path: this.meta.path,
        intent: this.meta.intent,
        persona: personaLabel(config.registry, this.meta.persona),
      },
      this.steps,
      { tookMs: Date.now() - this.startedAt, recordedOn: new Date().toISOString().slice(0, 10) },
    );
    const pathDir = join(this.dir, this.meta.path);
    writeFileSync(
      join(pathDir, "run.json"),
      runJson({
        steps: this.steps.length,
        ms: Date.now() - this.startedAt,
        recordedAt: new Date().toISOString(),
        stack: stack.name,
        visited: [...this.visited].sort(),
      }),
    );
    writeFileSync(join(pathDir, "diff.md"), diff);
    const file = join(pathDir, "README.md");
    writeFileSync(file, readme);
    return file;
  }
}
