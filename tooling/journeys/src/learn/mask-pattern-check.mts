/**
 * **After learning: every step this run recorded, whether it now has a mask,
 * and how much of the page that mask hides.**
 *
 * Only steps **this run wrote** are judged — screenshots newer than the run's
 * start. `--journey J4` records one journey and leaves the rest untouched, and
 * demanding a mask for a step that did not run reports as missing work nobody
 * asked for.
 *
 * ## The ceiling is on what was *learned*, not on the total
 *
 * What it catches is a box that crept across a card: inferred from two runs
 * disagreeing, growing by union, never reviewed. A **declared** box is the
 * opposite — a `data-volatile-date` a person put at a render site — and a list
 * of 25 dated rows legitimately masks a few percent of a tall page. So learned
 * coverage is judged against `MAX_STEP_COVERAGE`, and each declared box alone
 * against `MAX_DECLARED_BOX` (a marker on a row rather than the value inside it).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PNG } from "pngjs";
import { MASK_VERSION, MAX_DECLARED_BOX, MAX_STEP_COVERAGE } from "../mask/boxes.mts";
import type { MaskBox } from "../mask/boxes.mts";
import { paintedShare } from "../mask/share.mts";
import { recordedPaths } from "../evidence-tree.mts";

export type PatternCheckRow = {
  /** `J4-signing-in/common/happy`. */
  path: string;
  shot: string;
  boxes: number | null;
  coverage: number;
  learned: number;
  widestDeclared: number;
  widestDeclaredFrom: string | undefined;
  stale: boolean;
  unexercised: MaskBox[];
};

/** Step images in one `snapshots/` directory: not overlays, not diff artefacts. */
export const isStepImage = (file: string): boolean =>
  file.endsWith(".png") &&
  !file.endsWith("-mask.png") &&
  !/-(expected|actual|diff)\.png$/.test(file);

export function maskPatternCheck(evidenceRoot: string, since: number): PatternCheckRow[] {
  const rows: PatternCheckRow[] = [];
  for (const rec of recordedPaths(evidenceRoot)) {
    const shots = join(rec.dir, "snapshots");
    if (!existsSync(shots)) continue;
    for (const file of readdirSync(shots).sort()) {
      if (!isStepImage(file)) continue;
      const image = join(shots, file);
      if (statSync(image).mtimeMs < since) continue;
      const maskFile = `${image}.mask.json`;
      const stored = existsSync(maskFile)
        ? (JSON.parse(readFileSync(maskFile, "utf8")) as { version?: number; boxes: MaskBox[] })
        : undefined;
      // The image's own size: a full-page shot is taller than the viewport, and the
      // wrong denominator understates exactly the masks that matter.
      const { width, height } = PNG.sync.read(readFileSync(image));
      const boxes = stored?.boxes ?? [];
      const declared = boxes.filter((b) => b.provenance === "declared");
      const widest = [...declared].sort((a, b) => b.width * b.height - a.width * a.height)[0];
      rows.push({
        path: relative(evidenceRoot, rec.dir),
        shot: file,
        boxes: stored ? boxes.length : null,
        coverage: paintedShare(boxes, width, height),
        learned: paintedShare(
          boxes.filter((b) => b.provenance !== "declared"),
          width,
          height,
        ),
        widestDeclared: widest ? (widest.width * widest.height) / (width * height) : 0,
        widestDeclaredFrom: widest?.from,
        stale: Boolean(stored) && stored?.version !== MASK_VERSION,
        unexercised: declared.filter((b) => !b.exercised),
      });
    }
  }
  return rows;
}

export type PatternCheckVerdict = {
  without: PatternCheckRow[];
  tooBig: PatternCheckRow[];
  fatDeclared: PatternCheckRow[];
  stale: PatternCheckRow[];
};

export const judge = (rows: readonly PatternCheckRow[]): PatternCheckVerdict => ({
  without: rows.filter((r) => r.boxes === null),
  tooBig: rows.filter((r) => r.learned > MAX_STEP_COVERAGE),
  fatDeclared: rows.filter((r) => r.widestDeclared > MAX_DECLARED_BOX),
  stale: rows.filter((r) => r.stale),
});

/** The table the learner prints on success too: a pattern check whose normal output is silence cannot be told from one that never ran. */
export function patternCheckTable(rows: readonly PatternCheckRow[]): string[] {
  const out = [
    `${rows.length - rows.filter((r) => r.boxes === null).length} of ${rows.length} steps have a mask.`,
    "",
  ];
  out.push("  boxes   hidden  learned  step");
  for (const row of [...rows].sort((a, b) => b.coverage - a.coverage)) {
    const none = row.boxes === null;
    out.push(
      `  ${none ? "  —" : String(row.boxes).padStart(3)}  ` +
        `${none ? "     —" : `${(row.coverage * 100).toFixed(1)}%`.padStart(6)}  ` +
        `${none ? "      —" : `${(row.learned * 100).toFixed(1)}%`.padStart(7)}  ` +
        `${row.path}/${row.shot}${row.stale ? "  (stale rule)" : ""}`,
    );
  }
  return out;
}
