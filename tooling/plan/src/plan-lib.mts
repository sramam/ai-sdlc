/**
 * Parsing for the plan and the requirements (docs/kit/plan-and-requirements.md).
 *
 * Pure reading: nothing here prints, exits or writes. The CLIs (plan-check,
 * plan-status, item-check, trailers) are thin layers over it.
 *
 * ── The markdown conventions this parser reads ───────────────────────────────
 * Fenced code blocks are ignored everywhere. HTML comments are ignored when
 * looking for IDs, and read only for the `state=` markers named below.
 * IDs are matched case-insensitively and normalised to upper case; persona
 * slugs to lower case.
 *
 * Labelled fields. A field is `Label: value` at the start of a line (after an
 * optional `- ` list marker or `**bold**`), or after `·`, `|` or two or more
 * spaces on the same line — so `Actor: system:x · Trigger: …` and
 * `Personas: @a, @b       Journeys: J1` both read as two fields. A label in
 * its canonical capitalisation with the colon attached (`Journeys:`) also
 * starts a field after a single space, because prettier collapses the run of
 * spaces in the spec's own example. Only the labels in FIELD_LABELS count.
 *
 * personas.md
 *   A persona is a heading (level 2–4) whose text begins with `@slug`
 *   (backticks allowed). It is provisional when its heading says `provisional`,
 *   a `Status: provisional` field sits in its section, or an `idea` marker in
 *   it says `state=provisional`. The `Q-<nnn>` IDs in its section are what
 *   settles it.
 *
 * features/F<nn>-<slug>.md
 *   The feature ID comes from the file name. `Personas:`, `Journeys:` and
 *   `Phase:` fields are read from the lines before the first `##` heading
 *   (falling back to anywhere outside a requirement). A requirement is a
 *   heading `F<nn>-R<nn> <title>` (level 2–4). In its section:
 *     - withdrawn: the heading says `withdrawn`, or `Status: withdrawn`
 *     - out of scope: the heading says `out of scope`, `Status: out of scope`,
 *       or the heading sits inside a `## Out of scope` section
 *     - `Phase:` overrides the feature's; with no phase anywhere it is MVP
 *     - `Actor:`/`Actors:` — comma/`and`-separated; `@slug` or `system:<name>`
 *     - `Data:` — the entities it touches: each comma/semicolon-separated part's
 *       leading word (backticks stripped), e.g. `Data: Session (start, end), Reminder`
 *
 * journeys.md
 *   A journey is a heading (level 2–4) beginning `J<nn>`. Its persona is the
 *   `@slug`s on a `Persona:` field in its section (else those in its heading).
 *   Its steps are the list items (`1.`, `-`, `*`) in its section; a step cites
 *   the `F<nn>-R<nn>` IDs in its text.
 *
 * domain-model.md
 *   An entity is a level-3 heading; the name is the heading text up to ` — `,
 *   ` - `, `(` or `:`. A lifecycle event is a list item in the entity's section
 *   containing `→` or `->`: `- SUBMIT: DRAFT → SUBMITTED · sender: @organizer`.
 *   The event name is the text before the first `:`; its senders are the
 *   `@slug`/`system:<name>` after `sender:`, `senders:`, `sent by` or `by`.
 *   Entity names match case-insensitively, also with a trailing `s`/`es` removed.
 *
 * technology.md
 *   Triggers are read from either (both if present):
 *     - a table whose header has a `trigger` column and a `status` column;
 *       optional columns whose header contains `block` and `requirement`
 *     - a heading (level 2–4) whose own section text has a `Status:` field;
 *       `Blocks:` and `Requirements:` fields alongside it
 *   Status is `decided` (decided/accepted/chosen) or `pending`
 *   (pending/open/undecided/deferred). ADR IDs anywhere in the row/section count.
 *   Requirement IDs come from the requirements column/field, else from anywhere
 *   in the row/section.
 *
 * access-model.md
 *   Tenancy is declared by a `Tenancy: <model>` field (also `**Tenancy:** …`),
 *   or by an `idea` marker for its tenancy section
 *   (`<!-- idea: section=tenancy state=decided -->`). It is open when that
 *   field reads `open` or the marker says `state=open`, and undeclared when
 *   neither exists — which the requirements stage treats as a failure too.
 *
 * review.md — the readiness verdict
 *   Exactly one line, outside fenced code and HTML comments, of the form
 *
 *     Verdict: ready-to-plan
 *
 *   with one of four values, best first: `ready-to-plan`,
 *   `ready-with-assumptions`, `ready-pending-decisions`, `not-ready`. Leading
 *   `- ` and `**Verdict:**` bold are tolerated; nothing may follow the value.
 *   A `Verdict:` line with any other value is reported, never guessed at.
 *
 * Discovery outputs (REQUIRED_DISCOVERY)
 *   brd.md, prd.md, personas.md, features/, journeys.md, glossary.md,
 *   access-model.md, domain-model.md, ux.md, technology.md, review.md — under
 *   the requirements directory. Any one of them existing means discovery has
 *   started; the starter ships none. `README.md`, `project-brief.md` (kickoff's
 *   first pass) and `sources/` are not discovery outputs.
 *
 * `Dependencies:` lines — what an ADR accounts for
 *   In docs/adr/*.md and docs/architecture.md, a line (outside fenced code and
 *   HTML comments) beginning `Dependencies:` lists third-party packages,
 *   comma-separated, backticks optional:
 *
 *     Dependencies: typescript, `@types/node`, @scope/pkg
 *
 *   Several such lines in one file accumulate. Nothing else in the file counts:
 *   a package named only in prose is not accounted for.
 *
 * docs/architecture.md
 *   Components are the level-3 headings under a `## Components` heading; with
 *   no such section, every level-3 heading. A component cites a requirement
 *   when its section holds an `F<nn>-R<nn>` or an `ADR-<nnn>`.
 *
 * docs/plan/items/*.md and docs/plan/questions/Q-*.md
 *   YAML-subset frontmatter: `key: value`, `[a, b]` inline lists, `- a` block
 *   lists, quotes, and `# comments`. Item ID from `id:`, else the file name.
 *
 * docs/plan/README.md
 *   Holds a written plan when it has at least one `##` heading and no
 *   `<!-- plan:placeholder -->` marker. The starter's README has no `##`
 *   heading, so it reads as "no plan yet". A line `Stage: build` (outside
 *   fenced code and comments) declares the build stage before any workspace
 *   package exists — for a project whose first code is not a package.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ─── Dirs ─────────────────────────────────────────────────────────────────────

export interface Dirs {
  requirements: string;
  plan: string;
  adr: string;
}

export const DEFAULT_DIRS: Dirs = {
  requirements: "docs/requirements",
  plan: "docs/plan",
  adr: "docs/adr",
};
export const ARCHITECTURE_FILE = "docs/architecture.md";
export const PLAN_PLACEHOLDER_MARKER = "<!-- plan:placeholder -->";

// ─── IDs ──────────────────────────────────────────────────────────────────────

export const RE = {
  requirement: /\bF\d+-R\d+\b/gi,
  item: /\b(?:F\d+-\d+|X-\d+)\b/gi,
  feature: /\bF\d+\b(?!-)/g,
  journey: /\bJ\d+(?:\.\d+)?\b/g,
  question: /\bQ-\d+\b/gi,
  adr: /\bADR-\d+\b/gi,
  persona: /(?<![\w@./-])@([a-z][a-z0-9-]*[a-z0-9]|[a-z])(?![\w/@-])/gi,
  system: /\bsystem:[a-z0-9][\w.-]*/gi,
} as const;

export function normId(id: string): string {
  return id.trim().toUpperCase();
}

export function normPersona(p: string): string {
  return p.trim().replace(/^@/, "").toLowerCase();
}

function all(re: RegExp, text: string, group = 0): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`),
  )) {
    const v = m[group];
    if (v !== undefined) out.push(v);
  }
  return out;
}

export interface IdBag {
  requirements: string[];
  items: string[];
  features: string[];
  journeys: string[];
  questions: string[];
  adrs: string[];
  personas: string[];
}

/** Every ID-shaped token in a piece of prose. */
export function extractIds(text: string): IdBag {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    requirements: uniq(all(RE.requirement, text).map(normId)),
    items: uniq(all(RE.item, text).map(normId)),
    features: uniq(all(RE.feature, text).map(normId)),
    journeys: uniq(all(RE.journey, text).map(normId)),
    questions: uniq(all(RE.question, text).map(normId)),
    adrs: uniq(all(RE.adr, text).map(normId)),
    personas: uniq(all(RE.persona, text, 1).map(normPersona)),
  };
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

export function normalizeNewlines(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Blank out fenced code blocks, keeping line numbers. */
export function stripFences(text: string): string {
  const lines = normalizeNewlines(text).split("\n");
  let fence: string | null = null;
  return lines
    .map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (m && m[1] && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
        return "";
      }
      if (m && m[1]) {
        fence = m[1];
        return "";
      }
      return line;
    })
    .join("\n");
}

/** Blank out HTML comments, keeping line numbers. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
}

export interface Heading {
  level: number;
  text: string;
  /** 0-based line index. */
  index: number;
}

export function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = [];
  lines.forEach((line, index) => {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m && m[1] && m[2] !== undefined) out.push({ level: m[1].length, text: m[2], index });
  });
  return out;
}

/** Lines from the heading (exclusive) to the next heading at the same or a higher level. */
export function sectionBody(lines: string[], heads: Heading[], h: Heading): string[] {
  const next = heads.find((o) => o.index > h.index && o.level <= h.level);
  return lines.slice(h.index + 1, next ? next.index : lines.length);
}

/** Lines from the heading (exclusive) to the next heading of any level. */
export function ownBody(lines: string[], heads: Heading[], h: Heading): string[] {
  const next = heads.find((o) => o.index > h.index);
  return lines.slice(h.index + 1, next ? next.index : lines.length);
}

export const FIELD_LABELS = [
  "Actor",
  "Actors",
  "Trigger",
  "Preconditions",
  "Main flow",
  "Refusals",
  "Acceptance",
  "Data",
  "Lifecycle",
  "Non-functional",
  "Security",
  "Observability",
  "Shell",
  "Personas",
  "Persona",
  "Journeys",
  "Journey",
  "Phase",
  "Approved",
  "Owner",
  "Status",
  "Blocks",
  "Requirements",
  "Tenancy",
  "Sender",
  "Senders",
];

const FIELD_RE = new RegExp(
  `(?:^\\s*(?:[-*+]\\s+)?|·|•|\\||\\s{2,})\\s*\\**(${FIELD_LABELS.map((l) => l.replace(/-/g, "\\-")).join("|")})\\**\\s*:\\**`,
  "gi",
);

const FIELD_RE_LOOSE = new RegExp(
  `(?<=\\s)\\**(${FIELD_LABELS.map((l) => l.replace(/-/g, "\\-")).join("|")})\\**:\\**`,
  "g",
);

export interface Field {
  /** Lower-cased label. */
  label: string;
  value: string;
}

/** The labelled fields on one line (see the header for the convention). */
export function fieldsOf(line: string): Field[] {
  const strict = [...line.matchAll(FIELD_RE)];
  // A formatter collapses `@b       Journeys:` to `@b Journeys:`, so a label in
  // its canonical capitalisation, colon attached, also starts a field after one space.
  const loose = [...line.matchAll(FIELD_RE_LOOSE)].filter(
    (m) =>
      !strict.some(
        (s) =>
          (m.index ?? 0) < (s.index ?? 0) + s[0].length &&
          (s.index ?? 0) < (m.index ?? 0) + m[0].length,
      ),
  );
  const matches = [...strict, ...loose].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return matches.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const next = matches[i + 1];
    const end = next ? (next.index ?? line.length) : line.length;
    const value = line
      .slice(start, end)
      .trim()
      .replace(/^\*+|\*+$/g, "")
      .replace(/[·•|]\s*$/, "")
      .trim();
    return { label: (m[1] ?? "").toLowerCase(), value };
  });
}

/** First value of a labelled field among lines (labels compared lower-case). */
export function fieldIn(
  lines: string[],
  ...labels: string[]
): { value: string; index: number } | null {
  for (let i = 0; i < lines.length; i++) {
    for (const f of fieldsOf(lines[i] ?? ""))
      if (labels.includes(f.label)) return { value: f.value, index: i };
  }
  return null;
}

function cleanName(s: string): string {
  return s.replace(/`/g, "").replace(/\*\*/g, "").trim();
}

// ─── Frontmatter ──────────────────────────────────────────────────────────────

export type FmValue = string | string[] | null;

export interface Frontmatter {
  present: boolean;
  data: Record<string, FmValue>;
  body: string;
  /** 1-based line the body starts on. */
  bodyLine: number;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
}

function stripYamlComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1] ?? ""))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/** A YAML subset: scalars, `[a, b]`, `- a` block lists, quotes, comments. */
export function parseFrontmatter(text: string): Frontmatter {
  const src = normalizeNewlines(text);
  const lines = src.split("\n");
  if (lines[0]?.trim() !== "---") return { present: false, data: {}, body: src, bodyLine: 1 };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) return { present: false, data: {}, body: src, bodyLine: 1 };
  const data: Record<string, FmValue> = {};
  let i = 1;
  while (i < close) {
    const line = lines[i] ?? "";
    i++;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    const key = m[1].toLowerCase();
    const rest = stripYamlComment(m[2] ?? "").trim();
    if (rest.startsWith("[")) {
      const inner = rest.replace(/^\[/, "").replace(/\]\s*$/, "");
      data[key] = inner
        .split(",")
        .map((x) => unquote(x))
        .filter((x) => x.length > 0);
    } else if (rest === "") {
      const list: string[] = [];
      while (i < close && /^\s*-\s+/.test(lines[i] ?? "")) {
        list.push(unquote(stripYamlComment((lines[i] ?? "").replace(/^\s*-\s+/, ""))));
        i++;
      }
      data[key] = list.length ? list : null;
    } else {
      data[key] = unquote(rest);
    }
  }
  return { present: true, data, body: lines.slice(close + 1).join("\n"), bodyLine: close + 2 };
}

export function fmList(v: FmValue | undefined): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => x.trim()).filter(Boolean);
  const t = v.trim();
  if (!t || t === "~" || t.toLowerCase() === "null") return [];
  return t
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function fmString(v: FmValue | undefined): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? v.join(", ") : null;
  const t = v.trim();
  if (!t || t === "~" || t.toLowerCase() === "null") return null;
  return t;
}

// ─── Entities of the model ────────────────────────────────────────────────────

export interface Loc {
  /** Path relative to the root. */
  file: string;
  /** 1-based. */
  line: number;
}

export interface Persona extends Loc {
  slug: string;
  description: string;
  provisional: boolean;
  settledBy: string[];
}

export interface Feature extends Loc {
  id: string;
  title: string;
  personas: string[];
  journeys: string[];
  phase: string | null;
  /** `Approved: YYYY-MM-DD by <name>`: a person approved this spec (the one human gate). */
  approved: string | null;
}

export interface Requirement extends Loc {
  id: string;
  feature: string;
  title: string;
  withdrawn: boolean;
  outOfScope: boolean;
  phase: string | null;
  mvp: boolean;
  /** Raw actor tokens: `@slug`, `system:name`, or whatever else was written. */
  actors: string[];
  entities: string[];
  text: string;
}

export interface Step extends Loc {
  text: string;
  requirements: string[];
}

export interface Journey extends Loc {
  id: string;
  /** `J12` for `J12.1`, a persona-level journey; null for a top-level journey. */
  parent: string | null;
  title: string;
  personas: string[];
  steps: Step[];
}

export interface LifecycleEvent extends Loc {
  name: string;
  senders: string[];
}

export interface Entity extends Loc {
  name: string;
  provisional: boolean;
  events: LifecycleEvent[];
}

export interface Trigger extends Loc {
  name: string;
  status: "decided" | "pending" | "other";
  statusText: string;
  adrs: string[];
  blocks: IdBag;
  requirements: string[];
}

export interface Component extends Loc {
  name: string;
  requirements: string[];
  adrs: string[];
}

export interface Item extends Loc {
  id: string;
  fileId: string | null;
  title: string;
  requirements: string[];
  personas: string[];
  journeys: string[];
  milestone: string | null;
  depends: string[];
  estimate: string | null;
  dropped: string | null;
  raw: string;
}

export interface Question extends Loc {
  id: string;
  fileId: string | null;
  title: string;
  asked: string | null;
  blocks: string[];
  owner: string | null;
  answered: string | null;
}

export interface Doc {
  file: string;
  text: string;
}

export interface Model {
  root: string;
  dirs: Dirs;
  personas: Persona[];
  features: Feature[];
  requirements: Requirement[];
  journeys: Journey[];
  entities: Entity[];
  domainModelExists: boolean;
  triggers: Trigger[];
  technologyExists: boolean;
  accessModel: { exists: boolean; open: Loc | null; tenancy: Tenancy | null };
  /** The text of each required discovery document (null when absent), by file name. */
  discovery: Record<string, string | null>;
  review: ReviewVerdict;
  components: Component[];
  architectureExists: boolean;
  items: Item[];
  questions: Question[];
  /** ADR IDs present in the ADR directory (from file names). */
  adrs: string[];
  /** Documents whose prose is scanned for ID references. */
  docs: Doc[];
  plan: { readmeExists: boolean; written: boolean };
}

// ─── Parsers, one per document ────────────────────────────────────────────────

function readText(path: string): string | null {
  try {
    return normalizeNewlines(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function linesForParsing(text: string): string[] {
  return stripFences(text).split("\n");
}

export function parsePersonas(text: string, file: string): Persona[] {
  const lines = linesForParsing(text);
  const heads = headingsOf(lines);
  const out: Persona[] = [];
  for (const h of heads) {
    if (h.level < 2 || h.level > 4) continue;
    const m = /^`?@([a-z0-9][a-z0-9-]*)`?(.*)$/i.exec(h.text.trim());
    if (!m || !m[1]) continue;
    const body = sectionBody(lines, heads, h);
    const sectionText = [h.text, ...body].join("\n");
    const provisional =
      /\bprovisional\b/i.test(h.text) ||
      body.some((l) =>
        fieldsOf(l).some((f) => f.label === "status" && /provisional/i.test(f.value)),
      ) ||
      /<!--[^>]*state=provisional/i.test(sectionText);
    const desc =
      (m[2] ?? "").replace(/^[\s—–:-]+/, "").trim() ||
      body.map((l) => l.trim()).find((l) => l && !l.startsWith("<!--")) ||
      "";
    out.push({
      slug: m[1].toLowerCase(),
      description: desc,
      provisional,
      settledBy: extractIds(stripComments(sectionText)).questions,
      file,
      line: h.index + 1,
    });
  }
  return out;
}

function actorTokens(value: string): string[] {
  return value
    .split(/,|;|\band\b|\//)
    .map((s) => cleanName(s).replace(/[.]$/, ""))
    .filter((s) => s.length > 0);
}

function entityTokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of value) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    if ((c === "," || c === ";") && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out
    .map((p) => {
      const m = /^[\s`*]*([A-Za-z][\w-]*)/.exec(p);
      return m && m[1] ? m[1] : "";
    })
    .filter((n) => n && !/^(none|n\/a|tbd)$/i.test(n));
}

export function parseFeature(
  text: string,
  file: string,
  featureId: string,
): { feature: Feature; requirements: Requirement[] } {
  const lines = linesForParsing(text);
  const heads = headingsOf(lines);
  const reqHeads = heads.filter(
    (h) => h.level >= 2 && h.level <= 4 && /^`?F\d+-R\d+\b/i.test(h.text.trim()),
  );
  const inReq = new Set<number>();
  for (const h of reqHeads) {
    const body = sectionBody(lines, heads, h);
    for (let i = h.index; i <= h.index + body.length; i++) inReq.add(i);
  }
  const firstH2 = heads.find((h) => h.level <= 2 && h.level > 1);
  const preamble = lines.slice(0, firstH2 ? firstH2.index : lines.length);
  const outside = lines.map((l, i) => (inReq.has(i) ? "" : l));
  const pick = (label: string) => fieldIn(preamble, label) ?? fieldIn(outside, label);
  const personasF = pick("personas") ?? pick("persona");
  const journeysF = pick("journeys") ?? pick("journey");
  const phaseF = pick("phase");
  const approvedF = fieldIn(preamble, "approved");
  const title = (heads.find((h) => h.level === 1)?.text ?? featureId)
    .replace(/^`?F\d+`?\s*[—–:-]?\s*/i, "")
    .trim();
  const feature: Feature = {
    id: featureId,
    title,
    personas: personasF ? extractIds(personasF.value).personas : [],
    journeys: journeysF ? extractIds(journeysF.value).journeys : [],
    phase: phaseF ? cleanName(phaseF.value) || null : null,
    approved: approvedF?.value.trim() || null,
    file,
    line: 1,
  };
  const outOfScopeSections = heads.filter((h) => h.level === 2 && /out of scope/i.test(h.text));
  const requirements: Requirement[] = reqHeads.map((h) => {
    const m = /^`?(F\d+-R\d+)`?\s*(.*)$/i.exec(h.text.trim());
    const id = normId(m?.[1] ?? "");
    const body = sectionBody(lines, heads, h);
    const fields = body.flatMap((l) => fieldsOf(l));
    const status = fields.filter((f) => f.label === "status").map((f) => f.value);
    const phaseField = fields.find((f) => f.label === "phase");
    const phase = phaseField ? cleanName(phaseField.value) : feature.phase;
    const underOos = outOfScopeSections.some((s) => {
      const end = heads.find((o) => o.index > s.index && o.level <= 2);
      return h.index > s.index && (!end || h.index < end.index);
    });
    const withdrawn = /\bwithdrawn\b/i.test(h.text) || status.some((s) => /withdrawn/i.test(s));
    const outOfScope =
      underOos ||
      /\bout of scope\b/i.test(h.text) ||
      status.some((s) => /out of scope/i.test(s)) ||
      (phase !== null && /out of scope/i.test(phase));
    const actors = fields
      .filter((f) => f.label === "actor" || f.label === "actors")
      .flatMap((f) => actorTokens(f.value));
    const entities = fields.filter((f) => f.label === "data").flatMap((f) => entityTokens(f.value));
    return {
      id,
      feature: featureId,
      title: (m?.[2] ?? "").trim(),
      withdrawn,
      outOfScope,
      phase,
      mvp: phase === null || /^mvp\b/i.test(phase),
      actors,
      entities,
      text: [h.text, ...body].join("\n"),
      file,
      line: h.index + 1,
    };
  });
  return { feature, requirements };
}

export function parseJourneys(text: string, file: string): Journey[] {
  const lines = linesForParsing(text);
  const heads = headingsOf(lines);
  const out: Journey[] = [];
  const journeyId = (h: Heading) =>
    h.level >= 2 && h.level <= 4
      ? /^`?(J\d+(?:\.\d+)?)`?(?![\w.])\s*[—–:-]?\s*(.*)$/i.exec(h.text.trim())
      : null;
  for (const h of heads) {
    const m = journeyId(h);
    if (!m || !m[1]) continue;
    const id = normId(m[1]);
    // A journey with persona journeys under it owns only its own text: their
    // tasks and personas are theirs.
    const full = sectionBody(lines, heads, h);
    const hasChildren = heads.some(
      (o) =>
        o.index > h.index &&
        o.index <= h.index + full.length &&
        normId(journeyId(o)?.[1] ?? "").startsWith(`${id}.`),
    );
    const body = hasChildren ? ownBody(lines, heads, h) : full;
    const pf = fieldIn(body, "persona", "personas");
    const personas = pf ? extractIds(pf.value).personas : extractIds(h.text).personas;
    const steps: Step[] = [];
    body.forEach((l, i) => {
      if (!/^\s*(?:\d+[.)]|[-*+])\s+/.test(l)) return;
      if (fieldsOf(l).some((f) => f.label === "persona" || f.label === "personas")) return;
      steps.push({
        text: l.trim(),
        requirements: extractIds(stripComments(l)).requirements,
        file,
        line: h.index + 2 + i,
      });
    });
    out.push({
      id,
      parent: id.includes(".") ? (id.split(".")[0] ?? null) : null,
      title: (m[2] ?? "").trim(),
      personas,
      steps,
      file,
      line: h.index + 1,
    });
  }
  // A journey spanning personas walks with every persona of the journeys under it.
  for (const j of out) {
    const children = out.filter((c) => c.parent === j.id);
    if (children.length)
      j.personas = [...new Set([...j.personas, ...children.flatMap((c) => c.personas)])];
  }
  return out;
}

/** Journeys with no persona journeys under them: the ones a persona walks step by step. */
export function leafJourneys(journeys: Journey[]): Journey[] {
  const parents = new Set(journeys.map((j) => j.parent).filter(Boolean));
  return journeys.filter((j) => !parents.has(j.id));
}

export function parseDomainModel(text: string, file: string): Entity[] {
  const lines = linesForParsing(text);
  const heads = headingsOf(lines);
  return heads
    .filter((h) => h.level === 3)
    .map((h) => {
      const name = cleanName(h.text.split(/\s[—–-]\s|\(|:/)[0] ?? "");
      const body = sectionBody(lines, heads, h);
      const events: LifecycleEvent[] = [];
      body.forEach((l, i) => {
        if (!/^\s*(?:\d+[.)]|[-*+])\s+/.test(l) || !/→|->/.test(l)) return;
        const item = l.replace(/^\s*(?:\d+[.)]|[-*+])\s+/, "");
        const evName = cleanName(item.split(":")[0] ?? "");
        const senders: string[] = [];
        const sm = /\b(?:senders?\s*:|sent by\b|by\s*:|by\b)\s*(.*)$/i.exec(item);
        if (sm && sm[1]) {
          const tail = sm[1];
          for (const p of all(RE.persona, tail)) senders.push(p.toLowerCase());
          for (const s of all(RE.system, tail)) senders.push(s.toLowerCase());
        }
        events.push({ name: evName, senders, file, line: h.index + 2 + i });
      });
      return {
        name,
        provisional: /\bprovisional\b/i.test(h.text),
        events,
        file,
        line: h.index + 1,
      };
    })
    .filter((e) => e.name.length > 0);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function statusOf(text: string): Trigger["status"] {
  if (/\b(decided|accepted|chosen)\b/i.test(text)) return "decided";
  if (/\b(pending|open|undecided|deferred)\b/i.test(text)) return "pending";
  return "other";
}

export function parseTechnology(text: string, file: string): Trigger[] {
  const lines = linesForParsing(text);
  const out: Trigger[] = [];
  // Tables.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const sep = lines[i + 1] ?? "";
    if (!/^\s*\|/.test(line) || !/^\s*\|?\s*:?-{2,}/.test(sep)) continue;
    const header = splitRow(line).map((c) => c.toLowerCase());
    const ti = header.findIndex((c) => c.includes("trigger"));
    const si = header.findIndex((c) => c.includes("status"));
    if (ti < 0 || si < 0) continue;
    const bi = header.findIndex((c) => c.includes("block"));
    const ri = header.findIndex((c) => c.includes("requirement"));
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j] ?? ""); j++) {
      const raw = lines[j] ?? "";
      const cells = splitRow(raw);
      const rowText = stripComments(raw);
      const statusText = cells[si] ?? "";
      out.push({
        name: cleanName(cells[ti] ?? ""),
        status: statusOf(statusText),
        statusText,
        adrs: extractIds(rowText).adrs,
        blocks: extractIds(bi >= 0 ? (cells[bi] ?? "") : ""),
        requirements: extractIds(ri >= 0 ? (cells[ri] ?? "") : rowText).requirements,
        file,
        line: j + 1,
      });
    }
    i = j - 1;
  }
  // Headings with a Status: field in their own text.
  const heads = headingsOf(lines);
  for (const h of heads) {
    if (h.level < 2 || h.level > 4) continue;
    const body = ownBody(lines, heads, h);
    const st = fieldIn(body, "status");
    if (!st) continue;
    const bl = fieldIn(body, "blocks");
    const rq = fieldIn(body, "requirements");
    const sectionText = stripComments([h.text, ...body].join("\n"));
    out.push({
      name: cleanName(h.text),
      status: statusOf(st.value),
      statusText: st.value,
      adrs: extractIds(sectionText).adrs,
      blocks: extractIds(bl ? bl.value : ""),
      requirements: extractIds(rq ? rq.value : sectionText).requirements,
      file,
      line: h.index + 1,
    });
  }
  return out;
}

export interface Tenancy extends Loc {
  value: string;
}

/** The declared tenancy: a `Tenancy:` field, else an `idea` tenancy marker's state. */
export function parseTenancy(text: string, file: string): Tenancy | null {
  const lines = stripFences(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const f = fieldsOf(stripComments(lines[i] ?? "")).find((x) => x.label === "tenancy");
    if (f && f.value.trim()) return { value: f.value.trim(), file, line: i + 1 };
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /<!--\s*idea:[^>]*section=tenancy[^>]*state=([\w-]+)/i.exec(lines[i] ?? "");
    if (m && m[1]) return { value: m[1], file, line: i + 1 };
  }
  return null;
}

export const VERDICTS = [
  "ready-to-plan",
  "ready-with-assumptions",
  "ready-pending-decisions",
  "not-ready",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewVerdict {
  exists: boolean;
  /** Every well-formed `Verdict:` line. */
  verdicts: Array<{ value: Verdict } & Loc>;
  /** `Verdict:` lines whose value is not one of VERDICTS. */
  malformed: Array<{ text: string } & Loc>;
}

/** The `Verdict:` lines of review.md (see the header for the exact form). */
export function parseVerdict(text: string | null, file: string): ReviewVerdict {
  if (text === null) return { exists: false, verdicts: [], malformed: [] };
  const out: ReviewVerdict = { exists: true, verdicts: [], malformed: [] };
  stripComments(stripFences(text))
    .split("\n")
    .forEach((line, i) => {
      const m = /^\s*(?:[-*+]\s+)?\**Verdict:\**\s*(.*?)\s*$/i.exec(line);
      if (!m) return;
      const v = (m[1] ?? "").replace(/^\*+|\*+$/g, "").trim();
      if ((VERDICTS as readonly string[]).includes(v))
        out.verdicts.push({ value: v as Verdict, file, line: i + 1 });
      else out.malformed.push({ text: line.trim(), file, line: i + 1 });
    });
  return out;
}

/** The packages a document's `Dependencies:` lines account for. */
export function parseDependencyLines(text: string, file: string): Array<{ name: string } & Loc> {
  const out: Array<{ name: string } & Loc> = [];
  stripComments(stripFences(text))
    .split("\n")
    .forEach((line, i) => {
      const m = /^\s*(?:[-*+]\s+)?\**Dependencies:\**\s*(.*)$/.exec(line);
      if (!m) return;
      for (const raw of (m[1] ?? "").split(",")) {
        const name = raw.replace(/`/g, "").trim().replace(/[.;]$/, "");
        if (name) out.push({ name, file, line: i + 1 });
      }
    });
  return out;
}

export function parseAccessModel(text: string, file: string): Loc | null {
  const lines = stripFences(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (fieldsOf(stripComments(l)).some((f) => f.label === "tenancy" && /^open\b/i.test(f.value)))
      return { file, line: i + 1 };
    if (/<!--\s*idea:[^>]*section=tenancy[^>]*state=open/i.test(l)) return { file, line: i + 1 };
  }
  return null;
}

export function parseArchitecture(text: string, file: string): Component[] {
  const lines = linesForParsing(text);
  const heads = headingsOf(lines);
  const comp = heads.find((h) => h.level === 2 && /^components\b/i.test(h.text.trim()));
  let candidates = heads.filter((h) => h.level === 3);
  if (comp) {
    const end = heads.find((h) => h.index > comp.index && h.level <= 2);
    candidates = candidates.filter((h) => h.index > comp.index && (!end || h.index < end.index));
  }
  return candidates.map((h) => {
    const t = stripComments([h.text, ...sectionBody(lines, heads, h)].join("\n"));
    const ids = extractIds(t);
    return {
      name: cleanName(h.text),
      requirements: ids.requirements,
      adrs: ids.adrs,
      file,
      line: h.index + 1,
    };
  });
}

const ITEM_FILE = /^((?:F\d+-\d+)|(?:X-\d+))(?:-|\.md$)/i;
const QUESTION_FILE = /^(Q-\d+)(?:-|\.md$)/i;

export function parseItem(text: string, file: string, fileName: string): Item {
  const fm = parseFrontmatter(text);
  const fileId = ITEM_FILE.exec(fileName)?.[1]?.toUpperCase() ?? null;
  const d = fm.data;
  return {
    id: normId(fmString(d.id) ?? fileId ?? fileName),
    fileId,
    title: fmString(d.title) ?? "",
    requirements: fmList(d.requirements).map(normId),
    personas: fmList(d.personas).map(normPersona),
    journeys: fmList(d.journeys).map(normId),
    milestone: fmString(d.milestone),
    depends: fmList(d.depends).map(normId),
    estimate: fmString(d.estimate),
    dropped: fmString(d.dropped),
    raw: text,
    file,
    line: 1,
  };
}

export function parseQuestion(text: string, file: string, fileName: string): Question {
  const fm = parseFrontmatter(text);
  const fileId = QUESTION_FILE.exec(fileName)?.[1]?.toUpperCase() ?? null;
  const d = fm.data;
  const titleLine = fm.body.split("\n").find((l) => /^#\s+/.test(l));
  return {
    id: normId(fmString(d.id) ?? fileId ?? fileName),
    fileId,
    title: fmString(d.title) ?? (titleLine ? titleLine.replace(/^#\s+/, "") : ""),
    asked: fmString(d.asked),
    blocks: fmList(d.blocks).map((b) => (b.startsWith("@") ? b.toLowerCase() : normId(b))),
    owner: fmString(d.owner),
    answered: fmString(d.answered),
    file,
    line: 1,
  };
}

export function planWritten(readme: string): boolean {
  if (readme.includes(PLAN_PLACEHOLDER_MARKER)) return false;
  return /^##\s+\S/m.test(stripFences(readme));
}

// ─── Loading ──────────────────────────────────────────────────────────────────

function mdFiles(dir: string, opts: { recursive?: boolean; skip?: string[] } = {}): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (opts.recursive && !(opts.skip ?? []).includes(name)) out.push(...mdFiles(p, opts));
    } else if (name.toLowerCase().endsWith(".md")) out.push(p);
  }
  return out;
}

export function loadItems(root: string, dirs: Dirs = DEFAULT_DIRS): Item[] {
  return mdFiles(join(root, dirs.plan, "items")).map((p) => {
    const name = p.split("/").pop() ?? p;
    return parseItem(readText(p) ?? "", relative(root, p), name);
  });
}

export function loadQuestions(root: string, dirs: Dirs = DEFAULT_DIRS): Question[] {
  return mdFiles(join(root, dirs.plan, "questions"))
    .filter((p) => /^Q-/i.test(p.split("/").pop() ?? ""))
    .map((p) => {
      const name = p.split("/").pop() ?? p;
      return parseQuestion(readText(p) ?? "", relative(root, p), name);
    });
}

export function loadModel(root: string, dirs: Dirs = DEFAULT_DIRS): Model {
  const req = join(root, dirs.requirements);
  const rel = (p: string) => relative(root, p);
  const docs: Doc[] = [];
  const read = (p: string): string | null => {
    const t = readText(p);
    if (t !== null) docs.push({ file: rel(p), text: t });
    return t;
  };
  // Every requirements document except sources/ is scanned for references.
  const featureDir = join(req, "features");
  const named = new Set(
    ["personas.md", "journeys.md", "domain-model.md", "technology.md", "access-model.md"].map((n) =>
      join(req, n),
    ),
  );
  for (const p of mdFiles(req, { recursive: true, skip: ["sources", "features"] }))
    if (!named.has(p)) read(p);

  const personasText = read(join(req, "personas.md"));
  const personas = personasText ? parsePersonas(personasText, rel(join(req, "personas.md"))) : [];

  const features: Feature[] = [];
  const requirements: Requirement[] = [];
  for (const p of mdFiles(featureDir)) {
    const name = p.split("/").pop() ?? "";
    const m = /^(F\d+)-/i.exec(name);
    const text = read(p);
    if (!m || !m[1] || text === null) continue;
    const parsed = parseFeature(text, rel(p), normId(m[1]));
    features.push(parsed.feature);
    requirements.push(...parsed.requirements);
  }

  const journeysText = read(join(req, "journeys.md"));
  const journeys = journeysText ? parseJourneys(journeysText, rel(join(req, "journeys.md"))) : [];
  const dmText = read(join(req, "domain-model.md"));
  const entities = dmText ? parseDomainModel(dmText, rel(join(req, "domain-model.md"))) : [];
  const techText = read(join(req, "technology.md"));
  const triggers = techText ? parseTechnology(techText, rel(join(req, "technology.md"))) : [];
  const amText = read(join(req, "access-model.md"));
  const discovery: Record<string, string | null> = {};
  for (const name of REQUIRED_DISCOVERY)
    if (name !== "features/") {
      discovery[name] = readText(join(req, name));
    }
  const archText = read(join(root, ARCHITECTURE_FILE));
  const components = archText ? parseArchitecture(archText, ARCHITECTURE_FILE) : [];

  const items = loadItems(root, dirs);
  const questions = loadQuestions(root, dirs);
  for (const it of items) docs.push({ file: it.file, text: it.raw });
  for (const q of questions) {
    const t = readText(join(root, q.file));
    if (t !== null) docs.push({ file: q.file, text: t });
  }
  const readmePath = join(root, dirs.plan, "README.md");
  const readme = read(readmePath);

  const adrDir = join(root, dirs.adr);
  const adrs = existsSync(adrDir)
    ? readdirSync(adrDir)
        .map((n) => /^(ADR-\d+)/i.exec(n)?.[1])
        .filter((x): x is string => !!x)
        .map(normId)
    : [];

  return {
    root,
    dirs,
    personas,
    features,
    requirements,
    journeys,
    entities,
    domainModelExists: dmText !== null,
    triggers,
    technologyExists: techText !== null,
    accessModel: {
      exists: amText !== null,
      open: amText ? parseAccessModel(amText, rel(join(req, "access-model.md"))) : null,
      tenancy: amText ? parseTenancy(amText, rel(join(req, "access-model.md"))) : null,
    },
    discovery,
    review: parseVerdict(discovery["review.md"] ?? null, rel(join(req, "review.md"))),
    components,
    architectureExists: archText !== null,
    items,
    questions,
    adrs,
    docs,
    plan: { readmeExists: readme !== null, written: readme !== null && planWritten(readme) },
  };
}

// ─── Stage ────────────────────────────────────────────────────────────────────

export type Stage = "pre-discovery" | "requirements" | "plan" | "build";
export const STAGES: Stage[] = ["pre-discovery", "requirements", "plan", "build"];

/** True when stage `s` includes stage `of` (each stage includes the ones before it). */
export function reached(s: Stage, of: Stage): boolean {
  return STAGES.indexOf(s) >= STAGES.indexOf(of);
}

/** What discovery (`/idea`) must leave in the requirements directory. */
export const REQUIRED_DISCOVERY = [
  "brd.md",
  "prd.md",
  "personas.md",
  "features/",
  "journeys.md",
  "glossary.md",
  "access-model.md",
  "domain-model.md",
  "ux.md",
  "technology.md",
  "review.md",
] as const;

/** The required discovery outputs present (`features/` counts when it holds a `.md`). */
export function discoveryOutputs(root: string, dirs: Dirs = DEFAULT_DIRS): string[] {
  const req = join(root, dirs.requirements);
  return REQUIRED_DISCOVERY.filter((n) =>
    n === "features/" ? mdFiles(join(req, "features")).length > 0 : existsSync(join(req, n)),
  );
}

/** The `packages:` globs of pnpm-workspace.yaml (apps/* and packages/* when unreadable). */
export function workspaceGlobs(root: string): string[] {
  try {
    const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const out: string[] = [];
    let inPackages = false;
    for (const line of text.split("\n")) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
        if (m && m[1]) out.push(m[1].trim());
      }
    }
    return out;
  } catch {
    return ["apps/*", "packages/*"];
  }
}

/** Directories (relative to the root) of every workspace package that has a package.json. */
export function workspacePackages(root: string): string[] {
  const out: string[] = [];
  for (const g of workspaceGlobs(root)) {
    if (g.startsWith("!")) continue;
    if (g.endsWith("/*")) {
      const base = g.slice(0, -2);
      const dir = join(root, base);
      if (!existsSync(dir)) continue;
      for (const n of readdirSync(dir).sort())
        if (existsSync(join(dir, n, "package.json"))) out.push(`${base}/${n}`);
    } else if (existsSync(join(root, g, "package.json"))) out.push(g.replace(/\/$/, ""));
  }
  return [...new Set(out)];
}

/** The product's workspace packages: every one outside tooling/ (the starter's own). */
export function productPackages(root: string): string[] {
  return workspacePackages(root).filter((p) => !/^tooling(\/|$)/.test(p));
}

/** True when docs/plan/README.md declares `Stage: build` on a line of its own. */
export function declaresBuild(readme: string): boolean {
  return /^\s*(?:[-*+]\s+)?\**Stage:\**\s*build\s*$/im.test(stripComments(stripFences(readme)));
}

/**
 * The highest stage the repository has reached:
 *   build          a workspace package outside tooling/ exists, or the plan
 *                  README declares `Stage: build`
 *   plan           docs/plan/README.md holds a written plan
 *   requirements   any required discovery output exists
 *   pre-discovery  none does — the starter as shipped
 */
export function detectStage(
  root: string,
  dirs: Dirs = DEFAULT_DIRS,
): { stage: Stage; reason: string } {
  const pkgs = productPackages(root);
  if (pkgs.length) return { stage: "build", reason: `workspace package(s) ${pkgs.join(", ")}` };
  const readme = readText(join(root, dirs.plan, "README.md"));
  if (readme !== null && declaresBuild(readme))
    return { stage: "build", reason: `${dirs.plan}/README.md declares "Stage: build"` };
  if (readme !== null && planWritten(readme))
    return { stage: "plan", reason: `${dirs.plan}/README.md holds a written plan` };
  const found = discoveryOutputs(root, dirs);
  if (found.length)
    return {
      stage: "requirements",
      reason: `discovery has started (${dirs.requirements} holds ${found.join(", ")}); no written plan yet`,
    };
  return {
    stage: "pre-discovery",
    reason: `${dirs.requirements} holds no discovery output (${REQUIRED_DISCOVERY.join(", ")})`,
  };
}

// ─── Git ──────────────────────────────────────────────────────────────────────

export type GitResult =
  { ok: true; stdout: string } | { ok: false; reason: string; missing: boolean };

export function git(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 512 * 1024 * 1024 });
  if (r.error) {
    const missing = (r.error as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, reason: missing ? "git is not installed" : r.error.message, missing };
  }
  if (r.status !== 0) {
    const first = (r.stderr || "").split("\n").find((l) => l.trim()) ?? `exit ${r.status}`;
    return { ok: false, reason: `git ${args[0] ?? ""}: ${first.trim()}`, missing: false };
  }
  return { ok: true, stdout: r.stdout };
}

export function isRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--git-dir"]).ok;
}

export function hasHead(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
}

export function refExists(cwd: string, ref: string): boolean {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
}

export interface Trailer {
  key: string;
  value: string;
}

/**
 * Lines as `git interpret-trailers --parse` or `%(trailers:only,unfold)` print
 * them: `Key: value`, one per line. Continuation lines are folded in.
 */
export function parseTrailerLines(text: string): Trailer[] {
  const out: Trailer[] = [];
  for (const line of normalizeNewlines(text).split("\n")) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s?(.*)$/.exec(line);
    const last = out[out.length - 1];
    if (m && m[1]) out.push({ key: m[1], value: (m[2] ?? "").trim() });
    else if (/^\s/.test(line) && last) last.value = `${last.value} ${line.trim()}`;
  }
  return out;
}

/** The item ID a Progress:/Closes: value names: its first token. */
export function trailerItemId(value: string): string | null {
  const tok = value
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[.,;:)]+$/, "");
  return tok ? normId(tok) : null;
}

export interface CommitTrailers {
  commit: string;
  time: number;
  subject: string;
  trailers: Trailer[];
}

/**
 * Trailers of every commit `git log <revs>` lists, parsed by git's own trailer
 * parser (`%(trailers)` is the same code as `interpret-trailers --parse`), so a
 * message that merely quotes a trailer in its prose is not read as one.
 */
export function logTrailers(
  cwd: string,
  revs: string[],
): { ok: true; commits: CommitTrailers[] } | { ok: false; reason: string } {
  const r = git(cwd, [
    "log",
    "--format=%H%x1f%ct%x1f%s%x1f%(trailers:only,unfold)%x1e",
    ...revs,
    "--",
  ]);
  if (!r.ok) return { ok: false, reason: r.reason };
  const commits = r.stdout
    .split("\x1e")
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [commit = "", time = "0", subject = "", trailers = ""] = rec.split("\x1f");
      return { commit, time: Number(time), subject, trailers: parseTrailerLines(trailers) };
    });
  return { ok: true, commits };
}

export function trailerValues(trailers: Trailer[], key: string): string[] {
  return trailers.filter((t) => t.key.toLowerCase() === key.toLowerCase()).map((t) => t.value);
}

/**
 * The integration ref to read: origin/<branch> when it exists, else the local
 * branch (said, as "could not ask origin"), else nothing.
 */
export function integrationRef(
  cwd: string,
  branch: string,
): { ref: string; note: string | null } | { ref: null; note: string } {
  const remotes = git(cwd, ["remote"]);
  const hasOrigin = remotes.ok && remotes.stdout.split("\n").some((l) => l.trim() === "origin");
  if (hasOrigin && refExists(cwd, `refs/remotes/origin/${branch}`))
    return { ref: `origin/${branch}`, note: null };
  const why = hasOrigin ? `origin/${branch} does not exist` : "no origin remote";
  if (refExists(cwd, `refs/heads/${branch}`))
    return { ref: branch, note: `could not ask origin (${why}); read the local ${branch} instead` };
  return { ref: null, note: `could not ask origin (${why}), and there is no local ${branch}` };
}
