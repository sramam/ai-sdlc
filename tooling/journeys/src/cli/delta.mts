/**
 * `journeys delta` — what a re-recording changed, against a git ref.
 *
 * ```
 * journeys delta                 the table, to stdout
 * journeys delta --report        …and <reportRoot>/delta.md, with old beside new
 * journeys delta --since HEAD~1  what a commit changed, after the fact
 * ```
 *
 * The rule and the reasoning are in `delta/delta.mts`. **The report is not
 * committed**, and `--since` is why it need not be: against `HEAD` it answers
 * *what am I about to commit*; against any other ref it reconstructs the same
 * view for a past change from git alone. Exit 1 on a spurious mask or a step
 * that did not hold.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import { boxSummary, buildRows, deltaExit, gitAt, maskMoved, stepImages } from "../delta/delta.mts";
import type { DeltaBox, Row } from "../delta/delta.mts";
import { compareMasked, drawDiff, drawMask } from "../mask/boxes.mts";
import { filesUnder } from "../routes/adapter.mts";
import { existsSync, readFileSync } from "node:fs";

/** A mask growing by more than this many percentage points is listed, though it fails nothing by itself. */
export const GROWTH_NOTICE = 0.1;

type Pictures = { old: string; oldMask: string | null; delta: string | null; outside: string };

/** Materialise old images and diffs for every moved row, under `imagesDir`. */
function pictures(
  root: string,
  rows: readonly Row[],
  imagesDir: string,
  atRef: (p: string) => Buffer | null,
): Map<Row, Pictures> {
  const out = new Map<Row, Pictures>();
  rmSync(imagesDir, { recursive: true, force: true });
  for (const r of rows) {
    if ((r.verdict === "identical" && !r.spurious && !maskMoved(r)) || !r.old) continue;
    const dir = join(imagesDir, r.journey, dirname(r.step));
    mkdirSync(dir, { recursive: true });
    const stem = basename(r.png, ".png");
    const oldPath = join(dir, `${stem}-old.png`);
    writeFileSync(oldPath, r.old);

    let oldMask: string | null = null;
    const oldBoxes = atRef(`${r.png}.mask.json`);
    if (oldBoxes) {
      oldMask = join(dir, `${stem}-old-mask.png`);
      drawMask(oldPath, (JSON.parse(oldBoxes.toString()) as { boxes: DeltaBox[] }).boxes, oldMask);
    }

    let delta: string | null = null;
    let outside = "—";
    const now = join(root, r.png);
    if (r.verdict !== "resized") {
      const maskPath = `${now}.mask.json`;
      const boxes = existsSync(maskPath)
        ? (JSON.parse(readFileSync(maskPath, "utf8")) as { boxes: DeltaBox[] }).boxes
        : [];
      const answer = compareMasked(oldPath, now, boxes);
      outside =
        answer.kind === "same"
          ? "0 px"
          : answer.kind === "changed"
            ? `${answer.pixels} px (${(answer.ratio * 100).toFixed(2)}%)`
            : `resized ${answer.was} → ${answer.now}`;
      delta = join(dir, `${stem}-delta.png`);
      if (drawDiff(oldPath, now, boxes, delta) === null) delta = null;
    }
    out.set(r, { old: oldPath, oldMask, delta, outside });
  }
  return out;
}

export function renderReport(
  rows: readonly Row[],
  {
    since,
    link,
    pics = new Map(),
  }: { since: string; link: (repoRelativeOrAbs: string) => string; pics?: Map<Row, Pictures> },
): string {
  const journeys = [...new Set(rows.map((r) => r.journey))].sort();
  const count = (rs: readonly Row[], v: Row["verdict"]) => rs.filter((r) => r.verdict === v).length;
  const out: string[] = [
    "# Re-recording delta\n",
    `Working tree against \`${since}\`. ${rows.length} screenshots across ${journeys.length} journeys.\n`,
    "**A mask may only grow if its screenshot changed.** A row marked **spurious** is",
    "identical to its committed baseline with a mask that grew anyway — it learned a",
    "transient, and committing it hides part of the page from every future comparison.\n",
    "**Judge a changed row by where it moved, not by how much.** A moved edge and a",
    "renamed label can both land near 0.2%; approving on size alone is a check that cannot fail.\n",
  ];

  const notHeld = rows.filter((r) => !r.held);
  out.push(
    notHeld.length > 0
      ? `> ⚠️ **Not the new standard.** ${notHeld.length} step(s) did not hold on the last comparison — ` +
          "for a learning run that is pass 3. Do not commit them; re-run `journeys learn` for the " +
          "journey, and if it still moves, ask what is not deterministic.\n"
      : "Every step held on its last comparison.\n",
  );

  out.push("| journey | identical | changed | resized | added | spurious |");
  out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const j of journeys) {
    const rs = rows.filter((r) => r.journey === j);
    const eligible = count(rs, "identical");
    const sp = rs.filter((r) => r.spurious).length;
    // `n/a` where nothing could fire: an empty column because nothing was eligible
    // is not a pass, and reads like one.
    out.push(
      `| ${j} | ${eligible} | ${count(rs, "changed")} | ${count(rs, "resized")} | ${count(rs, "added")} ` +
        `| ${eligible === 0 ? "n/a" : sp === 0 ? "0" : `**${sp}**`} |`,
    );
  }
  out.push(
    "",
    "`n/a` in **spurious** means no row was eligible — it tests identical screenshots. It is not a pass.\n",
  );

  const moved = rows
    .filter((r) => r.maskBefore !== null && r.maskAfter !== null)
    .map((r) => ({ row: r, grew: (r.maskAfter! - r.maskBefore!) * 100 }))
    .sort((a, b) => b.grew - a.grew);
  const grown = moved.filter((m) => m.grew > GROWTH_NOTICE);
  if (grown.length > 0) {
    out.push(
      `## Masks that grew — ${grown.length}\n`,
      "| journey | step | before | after | growth |",
    );
    out.push("| --- | --- | ---: | ---: | ---: |");
    for (const m of grown) {
      out.push(
        `| ${m.row.journey} | ${m.row.step} | ${(m.row.maskBefore! * 100).toFixed(2)}% ` +
          `| ${(m.row.maskAfter! * 100).toFixed(2)}% | **+${m.grew.toFixed(2)}** |`,
      );
    }
    out.push(
      "",
      "Growth is not automatically wrong; it is the row to look at, because the union only grows.\n",
    );
  }
  const narrowed = moved.filter((m) => m.grew < -GROWTH_NOTICE);
  if (narrowed.length > 0) {
    out.push(
      `**${narrowed.length} mask(s) narrowed** — safe: a narrowing puts page back into the comparison.\n`,
    );
  }

  const notable = rows.filter((r) => r.verdict !== "identical" || r.spurious || maskMoved(r));
  if (notable.length === 0)
    out.push("Nothing moved — no screenshot changed and no mask did either.\n");
  else {
    out.push(`## What moved — ${notable.length} of ${rows.length}\n`);
    const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
    for (const j of journeys) {
      const rs = notable.filter((r) => r.journey === j);
      if (rs.length === 0) continue;
      out.push(
        `### ${j}\n`,
        "| step | what | mask before → after | boxes | pass 3 |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const r of rs) {
        out.push(
          `| [${r.step}](${link(r.png)}) | ${r.verdict}${r.detail ? ` — ${r.detail}` : ""}` +
            `${r.spurious ? " **spurious**" : ""} | ${r.maskBefore !== null && r.maskAfter !== null ? `${pct(r.maskBefore)} → ${pct(r.maskAfter)}` : "—"} ` +
            `| ${boxSummary(r)} | ${r.held ? "held" : "**did not hold**"} |`,
        );
      }
      out.push("");
      for (const r of rs) {
        const p = pics.get(r);
        if (!p) continue;
        const img = (alt: string, path: string | null) => (path ? `![${alt}](${link(path)})` : "—");
        const newMask = r.png.replace(/\.png$/, "-mask.png");
        out.push(
          `#### ${r.step} — ${r.verdict}${r.spurious ? ", **spurious**" : ""} · boxes: ${boxSummary(r)} · ` +
            `outside the new mask: ${p.outside} · pass 3: ${r.held ? "held" : "**did not hold**"}\n`,
          "| old reference | old mask | new reference | new mask | old → new, under the new mask |",
          "| --- | --- | --- | --- | --- |",
          `| ${img("old", p.old)} | ${img("old mask", p.oldMask)} | ${img("new", r.png)} | ${img("new mask", newMask)} | ${img("delta", p.delta)} |\n`,
        );
      }
    }
  }

  const spurious = rows.filter((r) => r.spurious);
  if (spurious.length > 0) {
    out.push(
      `## Spurious masks — ${spurious.length}\n`,
      "Restore the committed mask rather than taking these:\n",
      "```bash",
    );
    for (const r of spurious) out.push(`git checkout ${since} -- "${r.png}.mask.json"`);
    out.push("```\n");
  }
  return out.join("\n");
}

async function main(): Promise<number> {
  const root = journeysRoot();
  const config = await loadJourneysConfig(root);
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--since");
  const since = at >= 0 ? (argv[at + 1] ?? "HEAD") : "HEAD";
  const report = argv.includes("--report");

  const atRef = gitAt(root, since);
  const rows = buildRows(
    root,
    config.evidenceRoot,
    stepImages(filesUnder(root, config.evidenceRoot)),
    atRef,
  );

  const reportDir = join(root, config.reportRoot);
  const reportPath = join(reportDir, "delta.md");
  const link = (path: string) =>
    relative(reportDir, path.startsWith("/") ? path : join(root, path));
  const pics = report
    ? pictures(root, rows, join(reportDir, "delta"), atRef)
    : new Map<Row, Pictures>();
  const text = renderReport(rows, { since, link, pics });
  console.log(text);
  if (report) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportPath, text);
    console.log(`\nwrote ${relative(root, reportPath)}`);
  }
  return deltaExit(rows);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
