/**
 * **What a re-recording actually changed, per journey — against a git ref.**
 *
 * A recording run rewrites every file it walks, so `git status` reports the
 * whole suite modified and a reviewer cannot tell the four screenshots that
 * matter from the hundred that do not — which is how a spurious mask gets
 * committed with a clean conscience. door_nexa measured one re-record of seven
 * journeys: 81 identical, 32 resized, 4 changed.
 *
 * ## The rule this exists to enforce
 *
 * **A mask may only grow if its screenshot changed.** A mask is the difference
 * between two runs of unchanged software. If the recorded image is identical to
 * the committed one, nothing about that step varies, and a mask that grew
 * anyway learned a *transient* — a slow route, a table still settling. Left
 * committed it hides that region from every future comparison. So `spurious` is
 * a verdict that fails the run, not a note.
 *
 * ## Pass 3 beside every row
 *
 * A step still red on its last comparison leaves `snapshots/changed/<step>-diff.png`
 * behind, and a green one removes it — so the file's presence is the verdict,
 * read off disk rather than relayed. Any step that did not hold puts a warning
 * at the top: what the report shows is not the new standard yet.
 *
 * ## The report lives outside the evidence root
 *
 * door_nexa wrote its images into a scratch folder under `docs/`, and seven
 * pattern checks that enumerate the evidence then had to be taught to skip it — on
 * the one machine that ran it, since it was gitignored and CI never saw it.
 * Here the report and its images go under `reportRoot`, which no pattern check reads.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PNG } from "pngjs";
import { changedRegions, describeRegions } from "../mask/regions.mts";
import { paintedShare } from "../mask/share.mts";

export type Verdict = "identical" | "changed" | "resized" | "added";

export type DeltaBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  from: string;
  provenance?: string;
};

export type BoxDelta = {
  added: DeltaBox[];
  removed: DeltaBox[];
  grew: Array<{ from: string; before: number; after: number }>;
  shrank: Array<{ from: string; before: number; after: number }>;
};

export type Row = {
  journey: string;
  /** Path under the journey folder: `common/happy/01-open.png`. */
  step: string;
  /** Repository-relative. */
  png: string;
  old: Buffer | null;
  /** Pass 3's verdict, read off disk: a red comparison leaves its diff behind. */
  held: boolean;
  verdict: Verdict;
  detail: string;
  maskBefore: number | null;
  maskAfter: number | null;
  boxes: BoxDelta | null;
  spurious: boolean;
};

/** The bytes of a repository-relative path at `ref`, or null when it is new there. */
export const gitAt =
  (root: string, ref: string) =>
  (path: string): Buffer | null => {
    try {
      return execFileSync("git", ["show", `${ref}:./${path}`], {
        cwd: root,
        maxBuffer: 1 << 28,
        // A miss is the ordinary case — every added step — and must not print like breakage.
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };

/**
 * Two PNGs, with a tolerance of 8 per channel: a comparison that calls a
 * one-bit difference a change reports noise as signal, and this document is
 * read to decide what to look at.
 */
export function comparePng(
  oldBytes: Buffer,
  newBytes: Buffer,
): { verdict: Verdict; detail: string } {
  const a = PNG.sync.read(oldBytes);
  const b = PNG.sync.read(newBytes);
  if (a.width !== b.width || a.height !== b.height) {
    return { verdict: "resized", detail: `${a.width}×${a.height} → ${b.width}×${b.height}` };
  }
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i]! - b.data[i]!) > 8 ||
      Math.abs(a.data[i + 1]! - b.data[i + 1]!) > 8 ||
      Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 8
    ) {
      differing++;
    }
  }
  if (differing === 0) return { verdict: "identical", detail: "" };
  return {
    verdict: "changed",
    detail:
      `${((100 * differing) / (a.width * a.height)).toFixed(2)}% of pixels` +
      describeRegions(changedRegions(a, b)),
  };
}

/** A mask's painted share of its image, overlap counted once. */
export function maskShare(maskJson: Buffer | string | null, image: Buffer | null): number | null {
  if (!maskJson || !image) return null;
  try {
    const { width, height } = PNG.sync.read(image);
    const parsed = JSON.parse(maskJson.toString()) as { boxes: DeltaBox[] };
    return paintedShare(parsed.boxes, width, height);
  } catch {
    return null;
  }
}

/**
 * How two masks differ, box by box — matched on the element a box was snapped
 * to, with the trailing `[n]` stripped and the pair chosen by nearest centre,
 * so a few pixels of layout movement do not read as removed-and-added.
 * Growth and narrowing are both kept and mean different things: growth hides
 * page from every future comparison, a narrowing puts page back.
 */
export function boxDelta(before: readonly DeltaBox[], after: readonly DeltaBox[]): BoxDelta {
  const key = (b: DeltaBox) => `${b.provenance}:${b.from.replace(/\[\d+\]$/, "")}`;
  const groups = new Map<string, DeltaBox[]>();
  for (const b of before) groups.set(key(b), [...(groups.get(key(b)) ?? []), b]);

  const out: BoxDelta = { added: [], removed: [], grew: [], shrank: [] };
  for (const b of after) {
    const g = groups.get(key(b));
    if (!g || g.length === 0) {
      out.added.push(b);
      continue;
    }
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    let best = 0;
    let bestD = Infinity;
    g.forEach((c, i) => {
      const d = Math.hypot(c.x + c.width / 2 - cx, c.y + c.height / 2 - cy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const [was] = g.splice(best, 1);
    const a0 = was!.width * was!.height;
    const a1 = b.width * b.height;
    if (a1 > a0 * 1.2) out.grew.push({ from: b.from, before: a0, after: a1 });
    else if (a1 < a0 / 1.2) out.shrank.push({ from: b.from, before: a0, after: a1 });
  }
  out.removed = [...groups.values()].flat();
  return out;
}

/**
 * The one rule, as a function. A growth of more than one percentage point of
 * the page, on a screenshot that did not change by a single pixel.
 */
export const isSpurious = (
  verdict: Verdict,
  before: number | null,
  after: number | null,
): boolean => verdict === "identical" && before !== null && after !== null && after - before > 0.01;

/** Screenshots under the evidence root that are steps — not overlays, not Playwright-style diff artefacts. */
export function stepImages(files: readonly string[]): string[] {
  return files
    .filter((f) => f.endsWith(".png") && !f.endsWith("-mask.png"))
    .filter((f) => !/\/snapshots\/changed\//.test(f))
    .sort();
}

/** One row per step image, measured against `atRef`. `png` paths are repository-relative. */
export function buildRows(
  root: string,
  evidenceRoot: string,
  pngs: readonly string[],
  atRef: (path: string) => Buffer | null,
): Row[] {
  const prefix = `${evidenceRoot.replace(/\/$/, "")}/`;
  return pngs.map((png) => {
    const inside = png.slice(prefix.length);
    const journey = inside.split("/")[0]!;
    const step = inside.slice(journey.length + 1).replace("snapshots/", "");
    const abs = join(root, png);
    const now = readFileSync(abs);
    const old = atRef(png);
    const { verdict, detail } = old
      ? comparePng(old, now)
      : { verdict: "added" as Verdict, detail: "new step" };

    const maskPath = `${png}.mask.json`;
    const oldMask = atRef(maskPath);
    const newMask = existsSync(join(root, maskPath)) ? readFileSync(join(root, maskPath)) : null;
    const maskBefore = maskShare(oldMask, now);
    const maskAfter = maskShare(newMask, now);
    const parse = (b: Buffer | null) =>
      b ? (JSON.parse(b.toString()) as { boxes: DeltaBox[] }).boxes : null;
    const before = parse(oldMask);
    const after = parse(newMask);

    return {
      journey,
      step,
      png,
      old,
      held: !existsSync(join(dirname(abs), "changed", `${basename(abs, ".png")}-diff.png`)),
      verdict,
      detail,
      maskBefore,
      maskAfter,
      boxes: before && after ? boxDelta(before, after) : null,
      spurious: isSpurious(verdict, maskBefore, maskAfter),
    };
  });
}

/** A mask that changed shape counts as movement even when no pixel did. */
export const maskMoved = (r: Row): boolean =>
  r.boxes !== null &&
  (r.boxes.added.length > 0 ||
    r.boxes.removed.length > 0 ||
    r.boxes.grew.length > 0 ||
    r.boxes.shrank.length > 0);

export const boxSummary = (r: Row): string =>
  r.boxes
    ? [
        r.boxes.added.length ? `+${r.boxes.added.length}` : "",
        r.boxes.removed.length ? `−${r.boxes.removed.length}` : "",
        r.boxes.grew.length ? `${r.boxes.grew.length} grew` : "",
        r.boxes.shrank.length ? `${r.boxes.shrank.length} narrowed` : "",
      ]
        .filter(Boolean)
        .join(" ") || "same boxes"
    : "—";

/** The run's verdict: red on any spurious mask, or any step that did not hold. */
export const deltaExit = (rows: readonly Row[]): number =>
  rows.some((r) => r.spurious) || rows.some((r) => !r.held) ? 1 : 0;
