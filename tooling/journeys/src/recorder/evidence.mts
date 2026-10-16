/**
 * **What a recording writes, as text** — the narrative, the verification page,
 * `run.json` and the persona marker. Pure functions over what the recorder
 * collected, so the shape of the evidence is testable without a browser.
 *
 * ## Two documents per path, split by who is reading
 *
 * `README.md` is the walkthrough — what a person did and what they saw — meant
 * to be shareable with somebody who will never run the suite. `diff.md` is how
 * that walkthrough was *verified*: the mask, its regions, and the before/after
 * of anything that moved. One recording, rendered twice; neither hand-written.
 *
 * ## The verdict markers stay in `README.md`, and that is load-bearing
 *
 * The index (`cli/index.mts`) and the journey page read `FAILED_MARKER` and
 * `CHANGED_MARKER` out of the README to decide whether a path is green —
 * deliberately, so the index cannot report success while the page a reviewer
 * opens shows a failure. Moving either string to `diff.md` would make every
 * gate read a file that no longer carries it, and **every path would report
 * green**. One constant, imported by every writer and every reader, is what
 * stops the spellings drifting; door_nexa pinned it with a source-text census.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MaskBox } from "../mask/boxes.mts";
import { slug } from "../registry.mts";

/** A broken step. Read by `pathIsGreen`. */
export const FAILED_MARKER = "**failed here**";
/** A red comparison. Read by `pathIsGreen`. */
export const CHANGED_MARKER = "This step changed";

/** The line every generated page opens with. */
export const GENERATED = "> **Written by the journey recorder. Never edit this file.**";

export type Capture =
  | { kind: "text"; label: string; language: string; body: string }
  /** Markup the recorder renders and screenshots — an email as it lands, not as source. */
  | { kind: "html"; label: string; html: string }
  /**
   * A file the product produced, kept whole and, if a PDF, shown page by page
   * under the same mask gate as a screenshot. `volatile` is text the document's
   * renderer says varies, so the mask need not recognise its shape.
   */
  | {
      kind: "file";
      label: string;
      filename: string;
      bytes: Uint8Array;
      volatile?: readonly string[];
    }
  /** A PNG the step computed rather than photographed — gated like a render. */
  | { kind: "image"; label: string; png: Uint8Array };

export type StepVerdict = "unchanged" | "changed" | "not compared";

export type Masked = { boxes: MaskBox[]; coverage: number; file: string };

export type StepRecord = {
  n: number;
  title: string;
  note: string;
  shot: string;
  captures: Capture[];
  rendered: Array<{ label: string; file: string; masked?: Masked }>;
  files: Array<{ label: string; filename: string; href: string }>;
  verdict: StepVerdict;
  diff?: { expected: string; actual: string; diff: string };
  masked?: Masked;
  /** Regions still arriving when photographed — deliberately not masked. */
  settling: MaskBox[];
  failed: boolean;
};

export type PathMeta = {
  id: string;
  title: string;
  path: string;
  intent: string;
  /** The persona's label, as a reader sees it. */
  persona: string;
};

/**
 * A duration a person reads, not a number they convert. `Math.trunc`, not
 * `Math.floor`: the rounding census in `mask/dom.test.ts` reserves floor and
 * ceil for `boxOf`, and a duration is not a box.
 */
export const duration = (ms: number): string =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.trunc(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

/** A coverage figure a reader can judge — 0.4% is fine, 40% is a gate that is gone. */
export const percent = (ratio: number): string => `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}%`;

/** The step's filename stem: `03-read-the-code`. */
export const stepStem = (n: number, title: string): string =>
  `${String(n).padStart(2, "0")}-${slug(title)}`;

/** Green is read out of the narrative, so no flag beside it can disagree. */
export const pathIsGreen = (readme: string): boolean =>
  !readme.includes(FAILED_MARKER) && !readme.includes(CHANGED_MARKER);

/** Steps are counted out of the narrative, so the index cannot claim steps the file does not show. */
export const stepCount = (readme: string): number => readme.match(/^## \d+\. /gm)?.length ?? 0;

const boxRows = (boxes: readonly MaskBox[]): string[] => [
  "| what is excluded | where |",
  "| --- | --- |",
  ...boxes.map((b) => `| \`${b.from ?? "pixels"}\` | ${b.width}×${b.height} at ${b.x},${b.y} |`),
];

/**
 * The walkthrough and its verification page, from one list of steps.
 *
 * **One heading string, both files**, so the anchor a link points at is derived
 * from the text the heading is built from. The failed marker therefore lives in
 * the *body* — appending it to the heading would change the anchor on exactly
 * the step somebody most needs to jump to.
 */
export function renderPath(
  meta: PathMeta,
  steps: readonly StepRecord[],
  {
    tookMs,
    recordedOn,
    learn = "journeys learn",
  }: { tookMs: number; recordedOn: string; learn?: string },
): { readme: string; diff: string } {
  const { id, title, path, intent, persona } = meta;
  const changed = steps.filter((s) => s.verdict === "changed").length;
  const guarded = steps.filter((s) => s.verdict !== "not compared").length;

  const lines: string[] = [
    `# ${id} ${title} — \`${path}\``,
    "",
    GENERATED,
    "> The prose about what it means belongs on the review; this is the evidence,",
    "> and a hand-edited snapshot is a claim nobody checked.",
    "",
    `**Who** ${persona}`,
    "",
    `**Trying to** ${intent}`,
    "",
    // The date, not the time: a reviewer asks whether this is weeks old, and a
    // clock reading would churn the line on every run for no answer.
    `**Steps** ${steps.length} · **Took** ${duration(tookMs)} · **Recorded** ${recordedOn}`,
    "",
    "<sub>Every screenshot below was taken by the test that walks this path, in",
    "order. How each one was checked — and what was excluded from the check — is",
    "in [diff.md](diff.md).</sub>",
    "",
    "---",
    "",
  ];

  const dx: string[] = [
    `# ${id} ${title} — \`${path}\` · what was compared`,
    "",
    GENERATED,
    "> The walkthrough is [README.md](README.md); this is how it was verified.",
    "",
    `**Steps** ${steps.length} · **${guarded}** compared · **${changed}** changed`,
    "",
    "A step is compared against the screenshot committed last time, with a",
    "**mask** over whatever two runs of unchanged software disagreed about. The",
    "mask is learned rather than declared, so it covers what actually varies —",
    "and it is rendered here because a gate nobody can see is not one: a box",
    "that has crept across half the page passes every comparison for ever.",
    "",
    "---",
    "",
  ];

  for (const step of steps) {
    const heading = `${step.n}. ${step.title}`;
    const anchor = slug(heading);
    lines.push(`## ${heading}`, "", step.note, "");
    dx.push(`## ${heading}`, "", `<sub>[← the walkthrough](README.md#${anchor})</sub>`, "");
    if (step.failed) {
      lines.push(
        `> **The journey stops here** — it ${FAILED_MARKER}. The screenshot below is`,
        "> the page as it was when it broke, which is usually the whole diagnosis.",
        "",
      );
    }
    lines.push(`![${step.title}](snapshots/${step.shot})`, "");

    if (step.verdict === "changed" && step.diff) {
      lines.push(
        `> **${CHANGED_MARKER}** since the last recording. Somebody has to decide`,
        "> which of the two is right before this path can be tested against.",
        `> [The before, the after, and the pixels between →](diff.md#${anchor})`,
        "",
      );
      dx.push(
        "**Changed.** Before, after, and the pixels between. The run is red until",
        "somebody decides which of the two is right.",
        "",
        "| before | after | diff | mask |",
        "| --- | --- | --- | --- |",
        `| ![before](${step.diff.expected}) | ![after](${step.diff.actual}) | ${
          step.diff.diff ? `![diff](${step.diff.diff})` : "—"
        } | ${step.masked ? `![mask](snapshots/${step.masked.file})` : "—"} |`,
        "",
        "<sub>In the diff, solid red is what fell outside the mask and made the step red;",
        "tinted red is what the mask absorbed. The boxes are the mask itself.</sub>",
        "",
      );
    } else if (step.verdict === "unchanged") {
      lines.push(`<sub>[What was compared here →](diff.md#${anchor})</sub>`, "");
      dx.push(
        `**Unchanged** outside the mask${
          step.masked ? ` (${percent(step.masked.coverage)} of the page)` : ""
        }, against the committed screenshot.`,
        "",
      );
    } else {
      // In the README on purpose: an unguarded screenshot is a caveat about the
      // evidence itself, not a detail of how it was checked.
      lines.push(
        "<sub>**Not compared yet** — nothing guards this screenshot against a" +
          ` change. [Why →](diff.md#${anchor})</sub>`,
        "",
      );
      dx.push(
        "**Not compared yet** — no mask has been learned for this step, so a",
        `change to it would go unnoticed. Run \`${learn}\`.`,
        "",
      );
    }

    if (step.settling.length > 0) {
      dx.push(
        "> **This step photographed a page that was still arriving.** " +
          `${step.settling.length} region${step.settling.length === 1 ? "" : "s"} changed ` +
          "just after the screenshot and had stopped a moment later, so the recording is a " +
          "race rather than a state.",
        ">",
        "> Deliberately **not** masked: the fix is a wait condition on the settled state.",
        "",
        "| still arriving | where |",
        "| --- | --- |",
        ...step.settling.map(
          (b) => `| \`${b.from ?? "pixels"}\` | ${b.width}×${b.height} at ${b.x},${b.y} |`,
        ),
        "",
      );
    }

    if (step.masked && step.masked.boxes.length > 0) {
      const n = step.masked.boxes.length;
      dx.push(
        `**Excluded from the comparison** — ${n} region${n === 1 ? "" : "s"}, ` +
          `${percent(step.masked.coverage)} of the page.`,
        "",
        `![Masked regions](snapshots/${step.masked.file})`,
        "",
        ...boxRows(step.masked.boxes),
        "",
      );
    }

    for (const f of step.files) lines.push(`📎 **${f.label}** — [${f.filename}](${f.href})`, "");

    for (const r of step.rendered) {
      lines.push(`**${r.label}**`, "", `![${r.label}](snapshots/${r.file})`, "");
      if (r.masked && r.masked.boxes.length > 0) {
        const n = r.masked.boxes.length;
        dx.push(
          `**${r.label}** — compared, with ${n} region${n === 1 ? "" : "s"} excluded ` +
            `(${percent(r.masked.coverage)} of the image).`,
          "",
          `![${r.label}, masked](snapshots/${r.masked.file})`,
          "",
          ...boxRows(r.masked.boxes),
          "",
        );
      }
    }

    for (const c of step.captures) {
      if (c.kind !== "text") continue;
      const block = [
        `<details><summary>${c.label}</summary>`,
        "",
        "```" + c.language,
        // Trailing whitespace per line: page text carries it mid-capture, and it
        // fails `git diff --check`, which would make the evidence uncommittable.
        c.body
          .split("\n")
          .map((line) => line.replace(/[ \t]+$/, ""))
          .join("\n")
          .trim(),
        "```",
        "",
        "</details>",
        "",
      ];
      lines.push(...block);
      dx.push(...block);
    }
  }

  return { readme: lines.join("\n"), diff: dx.join("\n") };
}

export type RunStamp = {
  steps: number;
  /** The walk inside the test body — not the stack, not the browser launch. */
  ms: number;
  /** How fresh the evidence is, which git cannot say: a green re-run is fresh even if nothing moved. */
  recordedAt: string;
  /** Which stack produced `ms` — a timing whose stack is unknown supports no comparison. */
  stack: string;
  /** Pathnames the walk reached, as the browser saw them. Read by `journeys drift`. */
  visited: string[];
};

export const runJson = (stamp: RunStamp): string => JSON.stringify(stamp, null, 2) + "\n";

export function readRunJson(file: string): Partial<RunStamp> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<RunStamp>;
  } catch {
    return null;
  }
}

/** What marks a directory as a persona rather than a path: a file that says so. */
export const PERSONA_MARKER = "persona.json";

export function writePersonaMarker(dir: string, key: string, label: string): void {
  const file = join(dir, PERSONA_MARKER);
  const body = JSON.stringify({ key, label }, null, 2) + "\n";
  // Unchanged bytes are not rewritten, so a run does not churn a committed file.
  if (existsSync(file) && readFileSync(file, "utf8") === body) return;
  writeFileSync(file, body);
}

export function readPersonaMarker(dir: string): { key: string; label: string } | null {
  const file = join(dir, PERSONA_MARKER);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { key?: unknown; label?: unknown };
    return typeof parsed.key === "string"
      ? { key: parsed.key, label: typeof parsed.label === "string" ? parsed.label : parsed.key }
      : null;
  } catch {
    return null;
  }
}
