/**
 * `pnpm plan:status [--ready] [--journeys] [--html <file>] [--json]`
 *
 * Every item's status, derived from git (docs/kit/plan-and-requirements.md §
 * plan/items). Nothing is stored and nothing is committed; it reads what was
 * last fetched, so `git fetch` first for a current answer.
 *
 *   dropped      `dropped:` in the frontmatter — the one stored state
 *   done         a commit reachable from origin/<integration> with `Closes: <ID>`
 *   in progress  a claim: a remote branch named exactly the item ID
 *                (`f03-012`, matched case-insensitively; `pnpm claim` makes
 *                one atomically), or a `Progress: <ID>` on origin/<integration>
 *                within claimStaleDays and no `Closes:` (partial PRs land, and
 *                /land deletes the branch only on the PR that closes the item)
 *   stale claim  a claim older than claimStaleDays with no commit newer than
 *                claimStaleDays — on the branch or as a Progress: on the
 *                integration branch
 *   blocked      a `depends:` item not done, or an open question listing it
 *   ready        none of the above
 *   unknown      the integration branch could not be read at all
 *
 * When a claim was made is read, not guessed: the `Claimed-At:` trailer of the
 * claim commit (`Claim: <ID>`, found by walking first-parent from the branch
 * tip), else the committer time of the branch's oldest commit not on the
 * integration branch. A branch with neither — pushed straight off the
 * integration tip, say — has an unknown claim time and is never reported
 * stale on that account: the branch tip's date is the integration branch's
 * date, not the claimant's, and reading it made a fresh claim off an old tip
 * look abandoned.
 *
 * A branch named `<id>-<slug>` is not a claim (claims are canonical, so a
 * second claim is the same ref and is refused); it is listed in the notes.
 *
 * Choices where the spec leaves room:
 * - A claim outranks blocked: the item reads "in progress" with its blockers
 *   listed beside it, because somebody is on it either way.
 * - A Progress: older than claimStaleDays with no live branch reads "stale
 *   claim" rather than "ready": somebody started it and has not said they
 *   stopped.
 * - A dropped dependency still blocks, so the dependant gets replanned rather
 *   than silently unblocked.
 * - With no origin remote (or no origin/<integration>), the local integration
 *   branch and local branches are read instead, and the output says
 *   "could not ask origin".
 * - Trailers are parsed by git itself (`%(trailers:only,unfold)`, the same
 *   parser as `interpret-trailers --parse`).
 * - Questions are ranked by how many items they block, directly or through
 *   `depends:`.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import { isEntry } from "../../core/src/exec.mts";
import {
  DEFAULT_DIRS,
  git,
  integrationRef,
  loadModel,
  logTrailers,
  trailerItemId,
  trailerValues,
} from "./plan-lib.mts";
import type { CommitTrailers, Dirs, Item, Journey, Question } from "./plan-lib.mts";

export type Status =
  "done" | "in progress" | "stale claim" | "blocked" | "dropped" | "ready" | "unknown";

/** A claim branch: named exactly an item ID. */
export interface Claim {
  /** The item ID, upper case. */
  id: string;
  branch: string;
  /** Unix seconds of the branch tip's commit. */
  tip: number;
  /** Unix seconds the claim was made; null when it cannot be told. */
  claimedAt: number | null;
  claimedBy: string | null;
  source: "claim commit" | "oldest unique commit" | "unknown";
}

export interface GitFacts {
  /** The integration ref read, or null when none could be. */
  ref: string | null;
  notes: string[];
  closes: Map<string, { commit: string; time: number }>;
  /** Latest Progress: time per item on the integration ref. */
  progress: Map<string, number>;
  claims: Claim[];
  /** Unix seconds. */
  now: number;
}

export interface ItemStatus {
  item: Item;
  status: Status;
  reasons: string[];
}

export function factsFromCommits(commits: CommitTrailers[]): Pick<GitFacts, "closes" | "progress"> {
  const closes = new Map<string, { commit: string; time: number }>();
  const progress = new Map<string, number>();
  for (const c of commits) {
    for (const v of trailerValues(c.trailers, "Closes")) {
      const id = trailerItemId(v);
      if (id && !closes.has(id)) closes.set(id, { commit: c.commit, time: c.time });
    }
    for (const v of trailerValues(c.trailers, "Progress")) {
      const id = trailerItemId(v);
      if (id) progress.set(id, Math.max(progress.get(id) ?? 0, c.time));
    }
  }
  return { closes, progress };
}

export function deriveStatuses(
  items: Item[],
  questions: Question[],
  facts: GitFacts,
  claimStaleDays: number,
): ItemStatus[] {
  const staleAfter = claimStaleDays * 86400;
  const byId = new Map(items.map((i) => [i.id, i]));
  const done = (id: string) => facts.closes.has(id);
  const open = questions.filter((q) => !q.answered);
  return items.map((item) => {
    const reasons: string[] = [];
    if (item.dropped) return { item, status: "dropped", reasons: [item.dropped] };
    const closed = facts.closes.get(item.id);
    if (closed)
      return { item, status: "done", reasons: [`Closes: on ${closed.commit.slice(0, 10)}`] };
    if (facts.ref === null)
      return { item, status: "unknown", reasons: ["could not read the integration branch"] };

    for (const d of item.depends) {
      const dep = byId.get(d);
      if (!dep) reasons.push(`depends on ${d}, which does not exist`);
      else if (dep.dropped) reasons.push(`depends on ${d}, which is dropped`);
      else if (!done(d)) reasons.push(`depends on ${d}`);
    }
    for (const q of open) if (q.blocks.includes(item.id)) reasons.push(`waits on ${q.id}`);

    const days = (t: number) => `${Math.floor((facts.now - t) / 86400)}d ago`;
    const claims = facts.claims
      .filter((c) => c.id === item.id)
      .sort((a, b) => (a.claimedAt ?? Infinity) - (b.claimedAt ?? Infinity));
    const lastProgress = facts.progress.get(item.id);
    const claim = claims[0];
    if (claim) {
      const latest = Math.max(claim.tip, claim.claimedAt ?? 0, lastProgress ?? 0);
      const idle = facts.now - latest > staleAfter;
      const old = claim.claimedAt !== null && facts.now - claim.claimedAt > staleAfter;
      const when =
        claim.claimedAt === null
          ? "claim time unknown (no Claim: commit and no commit of its own)"
          : `claimed ${days(claim.claimedAt)}${claim.claimedBy ? ` by ${claim.claimedBy}` : ""}${claim.source === "claim commit" ? "" : ` (from its ${claim.source})`}`;
      const also = claims.slice(1).map((c) => `also claimed as ${c.branch}`);
      return {
        item,
        status: idle && old ? "stale claim" : "in progress",
        reasons: [
          `branch ${claim.branch}, ${when}; last commit ${days(latest)}`,
          ...also,
          ...reasons,
        ],
      };
    }
    if (lastProgress !== undefined) {
      const stale = facts.now - lastProgress > staleAfter;
      return {
        item,
        status: stale ? "stale claim" : "in progress",
        reasons: [`Progress: on ${facts.ref}, last ${days(lastProgress)}`, ...reasons],
      };
    }
    if (reasons.length) return { item, status: "blocked", reasons };
    return { item, status: "ready", reasons: [] };
  });
}

/** Items a question blocks, directly or through depends:. */
export function blockedBy(q: Question, items: Item[]): string[] {
  const out = new Set(q.blocks.filter((b) => items.some((i) => i.id === b)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items)
      if (!out.has(i.id) && i.depends.some((d) => out.has(d))) {
        out.add(i.id);
        grew = true;
      }
  }
  return [...out].sort();
}

export function rankQuestions(
  questions: Question[],
  items: Item[],
): Array<{ question: Question; direct: string[]; all: string[] }> {
  return questions
    .filter((q) => !q.answered)
    .map((q) => ({ question: q, direct: q.blocks, all: blockedBy(q, items) }))
    .sort(
      (a, b) =>
        b.all.length - a.all.length ||
        b.direct.length - a.direct.length ||
        a.question.id.localeCompare(b.question.id),
    );
}

// ─── Gathering ────────────────────────────────────────────────────────────────

const CLAIM_BRANCH = /^(f\d+-\d+|x-\d+)$/i;
const SLUGGED_BRANCH = /^(f\d+-\d+|x-\d+)-/i;

/** When and by whom `ref` (a claim branch for `id`) was claimed. */
export function readClaim(
  root: string,
  ref: string,
  id: string,
  integration: string,
): Pick<Claim, "claimedAt" | "claimedBy" | "source"> {
  const log = git(root, [
    "log",
    "--first-parent",
    "-i",
    `--grep=^Claim: ${id}$`,
    "--format=%ct%x1f%s%x1f%(trailers:key=Claimed-At,valueonly,unfold)%x1f%(trailers:key=Claimed-By,valueonly,unfold)%x1e",
    ref,
    "--",
  ]);
  if (log.ok)
    for (const rec of log.stdout.split("\x1e")) {
      const [ct = "", subject = "", at = "", by = ""] = rec.replace(/^\n+/, "").split("\x1f");
      if (subject.trim().toLowerCase() !== `claim: ${id.toLowerCase()}`) continue;
      const parsed = Date.parse(at.trim());
      return {
        claimedAt: Number.isNaN(parsed) ? Number(ct) : Math.floor(parsed / 1000),
        claimedBy: by.trim() || null,
        source: "claim commit",
      };
    }
  const own = git(root, ["log", "--first-parent", "--format=%ct", ref, `^${integration}`, "--"]);
  const oldest = own.ok ? own.stdout.trim().split("\n").filter(Boolean).pop() : undefined;
  if (oldest) return { claimedAt: Number(oldest), claimedBy: null, source: "oldest unique commit" };
  return { claimedAt: null, claimedBy: null, source: "unknown" };
}

export function gatherFacts(
  root: string,
  integration: string,
  now = Math.floor(Date.now() / 1000),
): GitFacts {
  const notes: string[] = [];
  const empty = { closes: new Map(), progress: new Map() };
  const probe = git(root, ["rev-parse", "--git-dir"]);
  if (!probe.ok)
    return {
      ref: null,
      notes: [`could not ask git: ${probe.reason}`],
      ...empty,
      claims: [],
      now,
    };
  const ref = integrationRef(root, integration);
  if (ref.note) notes.push(ref.note);
  if (ref.ref === null) return { ref: null, notes, ...empty, claims: [], now };
  const log = logTrailers(root, [ref.ref]);
  if (!log.ok)
    return {
      ref: null,
      notes: [...notes, `could not read ${ref.ref}: ${log.reason}`],
      ...empty,
      claims: [],
      now,
    };
  const remote = ref.ref.startsWith("origin/");
  const ns = remote ? "refs/remotes/origin/" : "refs/heads/";
  const refs = git(root, ["for-each-ref", "--format=%(refname)%09%(committerdate:unix)", ns]);
  const claims: Claim[] = [];
  if (refs.ok)
    for (const line of refs.stdout.split("\n")) {
      const [name = "", time = "0"] = line.split("\t");
      if (!name) continue;
      const short = name.slice(ns.length);
      if (CLAIM_BRANCH.test(short)) {
        const id = short.toUpperCase();
        claims.push({
          id,
          branch: short,
          tip: Number(time),
          ...readClaim(root, name, id, ref.ref),
        });
      } else if (SLUGGED_BRANCH.test(short))
        notes.push(
          `branch ${short} is not a claim: a claim branch is named exactly the item ID (${short.replace(/^((?:f\d+|x)-\d+)-.*$/i, "$1").toLowerCase()})`,
        );
    }
  else notes.push(`could not list branches: ${refs.reason}`);
  if (!remote) notes.push("claims read from local branches");
  return { ref: ref.ref, notes, ...factsFromCommits(log.commits), claims, now };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const ORDER: Status[] = [
  "in progress",
  "stale claim",
  "ready",
  "blocked",
  "unknown",
  "done",
  "dropped",
];

function groupBy<T>(xs: T[], keys: (x: T) => string[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) for (const k of keys(x)) m.set(k, [...(m.get(k) ?? []), x]);
  return new Map(
    [...m.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })),
  );
}

export const featureOf = (id: string) =>
  id.startsWith("X-") ? "X (platform)" : (/^F\d+/.exec(id)?.[0] ?? "?");

function counts(xs: ItemStatus[]): string {
  return ORDER.map((s) => [s, xs.filter((x) => x.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

function itemLine(s: ItemStatus): string {
  const why = s.reasons.length ? ` — ${s.reasons.join("; ")}` : "";
  return `    ${s.item.id.padEnd(9)} ${s.status.padEnd(12)} ${s.item.title}${why}`;
}

export interface Report {
  ref: string | null;
  notes: string[];
  statuses: ItemStatus[];
  questions: ReturnType<typeof rankQuestions>;
  journeys: Journey[];
}

export function renderText(r: Report, opts: { ready?: boolean; journeys?: boolean }): string[] {
  const out: string[] = [];
  out.push(`plan:status — read from ${r.ref ?? "(nothing: could not ask)"}, as of the last fetch`);
  for (const n of r.notes) out.push(`  note: ${n}`);
  if (opts.ready) {
    const ready = r.statuses.filter((s) => s.status === "ready");
    out.push(`Ready (${ready.length})`);
    for (const s of ready) out.push(itemLine(s));
    return out;
  }
  out.push(`Items: ${r.statuses.length ? counts(r.statuses) : "none"}`);
  const sections: Array<[string, (s: ItemStatus) => string[]]> = [
    ["milestone", (s) => [s.item.milestone ?? "(no milestone)"]],
    ["feature", (s) => [featureOf(s.item.id)]],
    [
      "persona",
      (s) => (s.item.personas.length ? s.item.personas.map((p) => `@${p}`) : ["(no persona)"]),
    ],
  ];
  for (const [title, keys] of sections) {
    out.push("", `By ${title}`);
    for (const [k, xs] of groupBy(r.statuses, keys)) {
      out.push(`  ${k} — ${counts(xs)}`);
      for (const s of xs) out.push(itemLine(s));
    }
  }
  if (opts.journeys) {
    out.push("", "By journey");
    const ids = new Set([
      ...r.journeys.map((j) => j.id),
      ...r.statuses.flatMap((s) => s.item.journeys),
    ]);
    for (const id of [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      const j = r.journeys.find((x) => x.id === id);
      const xs = r.statuses.filter((s) => s.item.journeys.includes(id) && s.status !== "dropped");
      const doneN = xs.filter((s) => s.status === "done").length;
      out.push(
        `  ${id}${j ? ` ${j.title}` : ""}${j?.personas[0] ? ` (@${j.personas[0]})` : ""} — ${doneN}/${xs.length} done`,
      );
      for (const s of xs) out.push(itemLine(s));
    }
  }
  out.push("", `Open questions (${r.questions.length}), most blocking first`);
  for (const q of r.questions)
    out.push(
      `    ${q.question.id.padEnd(7)} blocks ${String(q.all.length).padStart(2)} (${q.all.join(", ") || "nothing"})  ${q.question.title}${q.question.owner ? ` — owner ${q.question.owner}` : ""}`,
    );
  return out;
}

export function toJson(r: Report): unknown {
  return {
    ref: r.ref,
    notes: r.notes,
    items: r.statuses.map((s) => ({
      id: s.item.id,
      title: s.item.title,
      status: s.status,
      reasons: s.reasons,
      milestone: s.item.milestone,
      feature: featureOf(s.item.id),
      personas: s.item.personas,
      journeys: s.item.journeys,
      depends: s.item.depends,
    })),
    questions: r.questions.map((q) => ({
      id: q.question.id,
      title: q.question.title,
      owner: q.question.owner,
      blocks: q.direct,
      blocksAll: q.all,
    })),
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function renderHtml(r: Report, generated: string): string {
  const rows = (xs: ItemStatus[]) =>
    xs
      .map(
        (s) =>
          `<tr><td>${esc(s.item.id)}</td><td><span class="s s-${s.status.replace(/ /g, "-")}">${esc(s.status)}</span></td><td>${esc(s.item.title)}</td><td>${esc(s.reasons.join("; "))}</td></tr>`,
      )
      .join("\n");
  const groups = [...groupBy(r.statuses, (s) => [s.item.milestone ?? "(no milestone)"])]
    .map(
      ([k, xs]) =>
        `<h2>${esc(k)} <small>${esc(counts(xs))}</small></h2><table><thead><tr><th>Item</th><th>Status</th><th>Title</th><th>Why</th></tr></thead><tbody>${rows(xs)}</tbody></table>`,
    )
    .join("\n");
  const qs = r.questions
    .map(
      (q) =>
        `<li><b>${esc(q.question.id)}</b> ${esc(q.question.title)} — blocks ${q.all.length}${q.all.length ? `: ${esc(q.all.join(", "))}` : ""}${q.question.owner ? ` (owner ${esc(q.question.owner)})` : ""}</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plan status</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--done:#1f7a3a;--prog:#1d5fbf;--block:#b54708;--drop:#888}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#aaa;--line:#333;--done:#5cc27a;--prog:#7aa7f0;--block:#f0a35c;--drop:#888}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1000px;padding:16px}
table{border-collapse:collapse;width:100%;margin-bottom:16px;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
small,.note{color:var(--muted)}.s{font-weight:600}.s-done{color:var(--done)}.s-in-progress{color:var(--prog)}
.s-blocked,.s-stale-claim{color:var(--block)}.s-dropped{color:var(--drop)}
</style></head><body>
<h1>Plan status</h1>
<p class="note">Derived from ${esc(r.ref ?? "nothing (could not ask)")} at ${esc(generated)}. A view, not a source.${r.notes.map((n) => ` ${esc(n)}.`).join("")}</p>
<p>${esc(counts(r.statuses) || "No items.")}</p>
${groups}
<h2>Open questions</h2><ol>${qs || "<li>None.</li>"}</ol>
</body></html>
`;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const root = findRoot();
  if (!root) {
    console.error("plan:status: could not find sdlc.config.json above the current directory");
    return 2;
  }
  let dirs: Dirs = DEFAULT_DIRS;
  let integration = "dev";
  let stale = 7;
  try {
    const cfg = await loadConfig(root);
    dirs = { requirements: cfg.dirs.requirements, plan: cfg.dirs.plan, adr: cfg.dirs.adr };
    integration = cfg.branches.integration;
    stale = cfg.claimStaleDays;
  } catch (e) {
    console.error(
      `plan:status: could not load sdlc.config.json (${(e as Error).message}); using defaults`,
    );
  }
  const model = loadModel(root, dirs);
  const facts = gatherFacts(root, integration);
  const report: Report = {
    ref: facts.ref,
    notes: facts.notes,
    statuses: deriveStatuses(model.items, model.questions, facts, stale),
    questions: rankQuestions(model.questions, model.items),
    journeys: model.journeys,
  };
  const hi = argv.indexOf("--html");
  if (hi >= 0) {
    const file = argv[hi + 1];
    if (!file || file.startsWith("--")) {
      console.error("plan:status: --html needs a file");
      return 2;
    }
    writeFileSync(resolve(file), renderHtml(report, new Date().toISOString()));
    console.log(`plan:status: wrote ${resolve(file)}`);
  }
  if (argv.includes("--json")) console.log(JSON.stringify(toJson(report), null, 2));
  else if (hi < 0 || argv.includes("--ready") || argv.includes("--journeys"))
    for (const l of renderText(report, {
      ready: argv.includes("--ready"),
      journeys: argv.includes("--journeys"),
    }))
      console.log(l);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
