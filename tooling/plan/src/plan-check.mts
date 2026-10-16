/**
 * `pnpm plan:check [--stage requirements|plan|build] [--allow-unknown]`
 *
 * The census over the requirements and the plan
 * (docs/kit/plan-and-requirements.md § The census). Each stage includes the
 * ones before it. Prints its table on every run, success included; exits 1 on
 * a failure, and on a check that *could not ask* (git unavailable, say) unless
 * `--allow-unknown` is given.
 *
 * The stage defaults to the highest the repository has reached:
 *   requirements  until docs/plan/README.md holds a written plan (plan-lib.mts
 *                 § planWritten: a `##` heading and no `<!-- plan:placeholder -->`)
 *   plan          until apps/ holds an app (a directory with a package.json)
 *   build         after that
 *
 * Choices where the spec leaves room, each deliberate:
 * - A check with nothing to look at reports `vacuous`, which passes. On the
 *   empty starter every requirements check is vacuous and says so.
 * - Provisional personas are *reported* (warn) when they link an existing open
 *   `Q-`; a provisional persona linking no `Q-` fails, because "uncertain is
 *   allowed, if it is said" and the `Q-` is how it is said.
 * - Technology triggers: at the requirements stage a trigger must be decided
 *   (citing an ADR) or pending citing its requirement IDs. `blocks:` naming
 *   existing work items is required only at the plan stage.
 * - A requirement that is withdrawn or out of scope needs no journey.
 * - "A withdrawn ID reappearing" fails when a withdrawn requirement ID is
 *   defined again, cited by a journey step, or cited by a non-dropped item.
 *   Prose mentioning it ("replaces F03-R04") is allowed.
 * - The build-stage trailer check reads every commit reachable from HEAD:
 *   items are dropped, never deleted, so an ID a trailer ever named must keep
 *   existing.
 * - The dependency check accepts a package named anywhere in docs/adr/*.md or
 *   docs/architecture.md; workspace packages (by name or `workspace:`) are not
 *   third-party and need no entry.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import { isEntry } from "../../core/src/exec.mts";
import {
  ARCHITECTURE_FILE,
  DEFAULT_DIRS,
  STAGES,
  detectStage,
  extractIds,
  git,
  hasHead,
  hasRequirements,
  isRepo,
  logTrailers,
  normPersona,
  stripComments,
  stripFences,
  trailerItemId,
  trailerValues,
} from "./plan-lib.mts";
import type { CommitTrailers, Dirs, Doc, Model, Stage } from "./plan-lib.mts";
import { loadModel } from "./plan-lib.mts";

export type CheckState = "pass" | "fail" | "warn" | "vacuous" | "unknown";

export interface CheckResult {
  stage: Stage;
  name: string;
  state: CheckState;
  summary: string;
  details: string[];
}

const at = (l: { file: string; line: number }) => `${l.file}:${l.line}`;

function result(
  stage: Stage,
  name: string,
  problems: string[],
  okSummary: string,
  vacuous: string | null,
): CheckResult {
  if (problems.length)
    return {
      stage,
      name,
      state: "fail",
      summary: `${problems.length} problem(s)`,
      details: problems,
    };
  if (vacuous !== null) return { stage, name, state: "vacuous", summary: vacuous, details: [] };
  return { stage, name, state: "pass", summary: okSummary, details: [] };
}

// ─── Indexes ──────────────────────────────────────────────────────────────────

export interface Known {
  requirements: Set<string>;
  features: Set<string>;
  journeys: Set<string>;
  personas: Set<string>;
  items: Set<string>;
  questions: Set<string>;
  adrs: Set<string>;
}

export function knownIds(m: Model): Known {
  return {
    requirements: new Set(m.requirements.map((r) => r.id)),
    features: new Set(m.features.map((f) => f.id)),
    journeys: new Set(m.journeys.map((j) => j.id)),
    personas: new Set(m.personas.map((p) => p.slug)),
    items: new Set(m.items.map((i) => i.id)),
    questions: new Set(m.questions.map((q) => q.id)),
    adrs: new Set(m.adrs),
  };
}

function idExists(k: Known, id: string): boolean {
  if (id.startsWith("@")) return k.personas.has(normPersona(id));
  const u = id.toUpperCase();
  return (
    k.requirements.has(u) ||
    k.features.has(u) ||
    k.journeys.has(u) ||
    k.items.has(u) ||
    k.questions.has(u) ||
    k.adrs.has(u)
  );
}

// ─── Requirements stage ───────────────────────────────────────────────────────

export function checkUniqueIds(m: Model): CheckResult {
  const problems: string[] = [];
  const dup = <T,>(kind: string, xs: T[], key: (x: T) => string, loc: (x: T) => string) => {
    const seen = new Map<string, string>();
    for (const x of xs) {
      const k = key(x);
      const prev = seen.get(k);
      if (prev) problems.push(`${kind} ${k} is defined twice: ${prev} and ${loc(x)}`);
      else seen.set(k, loc(x));
    }
  };
  dup("persona", m.personas, (p) => `@${p.slug}`, at);
  dup("feature", m.features, (f) => f.id, at);
  dup("requirement", m.requirements, (r) => r.id, at);
  dup("journey", m.journeys, (j) => j.id, at);
  dup("item", m.items, (i) => i.id, at);
  dup("question", m.questions, (q) => q.id, at);
  for (const r of m.requirements)
    if (!r.id.startsWith(`${r.feature}-`))
      problems.push(`requirement ${r.id} is defined in ${r.feature}'s file (${at(r)})`);
  for (const i of m.items)
    if (i.fileId && i.fileId !== i.id)
      problems.push(`item ${i.file} is named for ${i.fileId} but its id is ${i.id}`);
  for (const q of m.questions)
    if (q.fileId && q.fileId !== q.id)
      problems.push(`question ${q.file} is named for ${q.fileId} but its id is ${q.id}`);
  const reqCount =
    m.personas.length + m.features.length + m.requirements.length + m.journeys.length;
  const planCount = m.items.length + m.questions.length;
  return result(
    "requirements",
    "unique-ids",
    problems,
    `${reqCount + planCount} IDs, none duplicated`,
    hasRequirements(m)
      ? null
      : `no requirements yet; ${planCount} plan ID(s) checked, none duplicated`,
  );
}

interface Ref {
  where: string;
  id: string;
}

function prose(doc: Doc): Ref[] {
  const out: Ref[] = [];
  stripComments(stripFences(doc.text))
    .split("\n")
    .forEach((line, i) => {
      const ids = extractIds(line);
      const where = `${doc.file}:${i + 1}`;
      for (const id of [
        ...ids.requirements,
        ...ids.items,
        ...ids.features,
        ...ids.journeys,
        ...ids.questions,
        ...ids.adrs,
      ])
        out.push({ where, id });
      for (const p of ids.personas) out.push({ where, id: `@${p}` });
    });
  return out;
}

export function checkReferences(m: Model): CheckResult {
  const k = knownIds(m);
  const refs: Ref[] = [];
  for (const f of m.features) {
    for (const p of f.personas) refs.push({ where: at(f), id: `@${p}` });
    for (const j of f.journeys) refs.push({ where: at(f), id: j });
  }
  for (const j of m.journeys) {
    for (const p of j.personas) refs.push({ where: at(j), id: `@${p}` });
    for (const s of j.steps) for (const r of s.requirements) refs.push({ where: at(s), id: r });
  }
  for (const p of m.personas) for (const q of p.settledBy) refs.push({ where: at(p), id: q });
  for (const e of m.entities)
    for (const ev of e.events)
      for (const s of ev.senders) if (s.startsWith("@")) refs.push({ where: at(ev), id: s });
  for (const i of m.items) {
    for (const r of i.requirements) refs.push({ where: i.file, id: r });
    for (const p of i.personas) refs.push({ where: i.file, id: `@${p}` });
    for (const j of i.journeys) refs.push({ where: i.file, id: j });
    for (const d of i.depends) refs.push({ where: i.file, id: d });
  }
  for (const q of m.questions) for (const b of q.blocks) refs.push({ where: q.file, id: b });
  for (const doc of m.docs) refs.push(...prose(doc));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const r of refs) {
    const key = `${r.where}|${r.id}`;
    if (seen.has(key) || idExists(k, r.id)) continue;
    seen.add(key);
    problems.push(`${r.where} names ${r.id}, which does not exist`);
  }
  return result(
    "requirements",
    "references",
    problems,
    `${refs.length} reference(s), all resolve`,
    hasRequirements(m)
      ? null
      : `no requirements yet; ${refs.length} reference(s) in the plan, all resolve`,
  );
}

export function checkWithdrawn(m: Model): CheckResult {
  const withdrawn = new Set(m.requirements.filter((r) => r.withdrawn).map((r) => r.id));
  const problems: string[] = [];
  for (const id of withdrawn) {
    const defs = m.requirements.filter((r) => r.id === id && !r.withdrawn);
    for (const d of defs) problems.push(`${id} is withdrawn and defined again at ${at(d)}`);
  }
  for (const j of m.journeys)
    for (const s of j.steps)
      for (const r of s.requirements)
        if (withdrawn.has(r)) problems.push(`${at(s)}: ${j.id} cites withdrawn ${r}`);
  for (const i of m.items)
    if (!i.dropped)
      for (const r of i.requirements)
        if (withdrawn.has(r)) problems.push(`${i.file}: ${i.id} cites withdrawn ${r}`);
  return result(
    "requirements",
    "withdrawn-ids",
    problems,
    `${withdrawn.size} withdrawn, none reappears`,
    withdrawn.size ? null : "no withdrawn requirement",
  );
}

export function checkRequirementJourneys(m: Model): CheckResult {
  const live = m.requirements.filter((r) => !r.withdrawn && !r.outOfScope);
  const served = new Set(m.journeys.flatMap((j) => j.steps.flatMap((s) => s.requirements)));
  const problems = live
    .filter((r) => !served.has(r.id))
    .map((r) => `${r.id} (${at(r)}) is served by no journey step`);
  return result(
    "requirements",
    "requirement-journeys",
    problems,
    `${live.length} requirement(s), each served by a journey`,
    live.length ? null : "no requirements yet",
  );
}

export function checkJourneySteps(m: Model): CheckResult {
  const problems: string[] = [];
  for (const j of m.journeys) {
    if (!j.steps.length) problems.push(`${j.id} (${at(j)}) has no steps`);
    for (const s of j.steps)
      if (!s.requirements.length)
        problems.push(`${at(s)}: a ${j.id} step cites no requirement: ${s.text}`);
  }
  return result(
    "requirements",
    "journey-steps",
    problems,
    `${m.journeys.length} journey(s), every step cites a requirement`,
    m.journeys.length ? null : "no journeys yet",
  );
}

export function checkJourneyPersona(m: Model): CheckResult {
  const problems = m.journeys
    .filter((j) => j.personas.length !== 1)
    .map(
      (j) =>
        `${j.id} (${at(j)}) names ${j.personas.length ? j.personas.map((p) => `@${p}`).join(", ") : "no persona"}; a journey names exactly one`,
    );
  return result(
    "requirements",
    "journey-persona",
    problems,
    `${m.journeys.length} journey(s), one persona each`,
    m.journeys.length ? null : "no journeys yet",
  );
}

export function checkFeaturePersonas(m: Model): CheckResult {
  const problems = m.features
    .filter((f) => !f.personas.length)
    .map((f) => `${f.id} (${f.file}) names no persona`);
  return result(
    "requirements",
    "feature-personas",
    problems,
    `${m.features.length} feature(s), each names a persona`,
    m.features.length ? null : "no features yet",
  );
}

export function checkPersonaJourneys(m: Model): CheckResult {
  const walked = new Set(m.journeys.flatMap((j) => j.personas));
  const problems = m.personas
    .filter((p) => !walked.has(p.slug))
    .map((p) => `@${p.slug} (${at(p)}) has no journey`);
  return result(
    "requirements",
    "persona-journeys",
    problems,
    `${m.personas.length} persona(s), each with a journey`,
    m.personas.length ? null : "no personas yet",
  );
}

export function checkActors(m: Model): CheckResult {
  const k = knownIds(m);
  const problems: string[] = [];
  let n = 0;
  for (const r of m.requirements) {
    if (r.withdrawn) continue;
    for (const a of r.actors) {
      n++;
      if (/^@/.test(a)) {
        if (!k.personas.has(normPersona(a)))
          problems.push(`${r.id} (${at(r)}): actor ${a} is not in personas.md`);
      } else if (!/^system:[a-z0-9][\w.-]*$/i.test(a)) {
        problems.push(
          `${r.id} (${at(r)}): actor "${a}" is neither a registered @persona nor system:<name>`,
        );
      }
    }
  }
  return result(
    "requirements",
    "actors",
    problems,
    `${n} actor(s), all registered or system:`,
    n ? null : "no actors named yet",
  );
}

export function checkProvisional(m: Model): CheckResult {
  const qs = new Map(m.questions.map((q) => [q.id, q]));
  const prov = m.personas.filter((p) => p.provisional);
  const problems: string[] = [];
  const notes: string[] = [];
  for (const p of prov) {
    const linked = p.settledBy.filter((id) => qs.has(id));
    if (!linked.length) {
      problems.push(`@${p.slug} (${at(p)}) is provisional and links no existing Q- file`);
      continue;
    }
    for (const id of linked) {
      const q = qs.get(id);
      if (q?.answered)
        notes.push(`@${p.slug} is provisional, but ${id} was answered ${q.answered}: settle it`);
      else notes.push(`@${p.slug} is provisional until ${id} is answered`);
    }
  }
  if (problems.length)
    return {
      stage: "requirements",
      name: "provisional-personas",
      state: "fail",
      summary: `${problems.length} problem(s)`,
      details: [...problems, ...notes],
    };
  if (prov.length)
    return {
      stage: "requirements",
      name: "provisional-personas",
      state: "warn",
      summary: `${prov.length} provisional persona(s)`,
      details: notes,
    };
  return result(
    "requirements",
    "provisional-personas",
    [],
    "no provisional persona",
    m.personas.length ? null : "no personas yet",
  );
}

function entityKey(name: string): string[] {
  const n = name.toLowerCase();
  const out = [n];
  if (n.endsWith("es")) out.push(n.slice(0, -2));
  if (n.endsWith("s")) out.push(n.slice(0, -1));
  return out;
}

export function checkEntities(m: Model): CheckResult {
  const defined = new Set(m.entities.map((e) => e.name.toLowerCase()));
  const problems: string[] = [];
  let n = 0;
  for (const r of m.requirements) {
    if (r.withdrawn) continue;
    for (const e of r.entities) {
      n++;
      if (!entityKey(e).some((k) => defined.has(k)))
        problems.push(
          `${r.id} (${at(r)}) names entity "${e}", which domain-model.md does not define`,
        );
    }
  }
  return result(
    "requirements",
    "entities",
    problems,
    `${n} entity reference(s), all defined`,
    n ? null : "no requirement names an entity yet",
  );
}

export function checkSenders(m: Model): CheckResult {
  const k = knownIds(m);
  const events = m.entities.flatMap((e) => e.events.map((ev) => ({ e, ev })));
  const problems: string[] = [];
  for (const { e, ev } of events) {
    if (!ev.senders.length) problems.push(`${at(ev)}: ${e.name}.${ev.name} has no sender`);
    for (const s of ev.senders)
      if (s.startsWith("@") && !k.personas.has(normPersona(s)))
        problems.push(`${at(ev)}: ${e.name}.${ev.name} is sent by ${s}, not in personas.md`);
  }
  return result(
    "requirements",
    "lifecycle-senders",
    problems,
    `${events.length} lifecycle event(s), each with a sender`,
    events.length ? null : "no lifecycle events yet",
  );
}

export function checkTriggers(m: Model): CheckResult {
  const problems: string[] = [];
  for (const t of m.triggers) {
    if (t.status === "decided") {
      if (!t.adrs.length) problems.push(`${at(t)}: "${t.name}" is decided but cites no ADR`);
    } else if (t.status === "pending") {
      if (!t.requirements.length)
        problems.push(`${at(t)}: "${t.name}" is pending and cites no requirement ID`);
    } else
      problems.push(
        `${at(t)}: "${t.name}" is neither decided nor pending (status: "${t.statusText}")`,
      );
  }
  return result(
    "requirements",
    "technology-triggers",
    problems,
    `${m.triggers.length} trigger(s), each decided or pending with its requirements`,
    m.triggers.length ? null : "no technology triggers recorded yet",
  );
}

export function checkAccessModel(m: Model): CheckResult {
  if (!m.accessModel.exists)
    return result("requirements", "access-model", [], "", "no access-model.md yet");
  const open = m.accessModel.open;
  return result(
    "requirements",
    "access-model",
    open ? [`${at(open)}: tenancy is open, which blocks the data model`] : [],
    "tenancy is settled",
    null,
  );
}

// ─── Plan stage ───────────────────────────────────────────────────────────────

export function checkItemsCite(m: Model): CheckResult {
  const live = m.items.filter((i) => !i.dropped);
  const problems = live
    .filter((i) => !i.id.startsWith("X-") && !i.requirements.length)
    .map((i) => `${i.id} (${i.file}) cites no requirement`);
  return result(
    "plan",
    "items-cite-requirements",
    problems,
    `${live.length} item(s); every feature item cites a requirement`,
    live.length ? null : "no items yet",
  );
}

export function checkMvpCoverage(m: Model): CheckResult {
  const covered = new Set(m.items.filter((i) => !i.dropped).flatMap((i) => i.requirements));
  const mvp = m.requirements.filter((r) => r.mvp && !r.withdrawn && !r.outOfScope);
  const problems = mvp
    .filter((r) => !covered.has(r.id))
    .map((r) => `${r.id} (${at(r)}) is MVP and no item covers it`);
  return result(
    "plan",
    "mvp-coverage",
    problems,
    `${mvp.length} MVP requirement(s), each covered by an item`,
    mvp.length ? null : "no MVP requirements yet",
  );
}

export function findCycles(edges: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const seenCycle = new Set<string>();
  const visit = (n: string) => {
    state.set(n, 1);
    stack.push(n);
    for (const d of edges.get(n) ?? []) {
      if (state.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d));
        const key = [...cyc].sort().join(",");
        if (!seenCycle.has(key)) {
          seenCycle.add(key);
          cycles.push([...cyc, d]);
        }
      } else if (!state.has(d) && edges.has(d)) visit(d);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of [...edges.keys()].sort()) if (!state.has(n)) visit(n);
  return cycles;
}

export function checkDependsCycle(m: Model): CheckResult {
  const edges = new Map(m.items.map((i) => [i.id, i.depends]));
  const cycles = findCycles(edges);
  const n = m.items.reduce((s, i) => s + i.depends.length, 0);
  return result(
    "plan",
    "depends-cycle",
    cycles.map((c) => `cycle: ${c.join(" → ")}`),
    `${n} dependency edge(s), no cycle`,
    m.items.length ? null : "no items yet",
  );
}

export function checkPendingBlocks(m: Model): CheckResult {
  const items = new Set(m.items.map((i) => i.id));
  const pending = m.triggers.filter((t) => t.status === "pending");
  const problems = pending
    .filter((t) => !t.blocks.items.some((id) => items.has(id)))
    .map((t) => `${at(t)}: "${t.name}" is pending and its blocks: names no existing work item`);
  return result(
    "plan",
    "pending-triggers-block",
    problems,
    `${pending.length} pending trigger(s), each blocking items`,
    pending.length ? null : "no pending technology trigger",
  );
}

export function checkArchitecture(m: Model): CheckResult {
  const problems = m.components
    .filter((c) => !c.requirements.length && !c.adrs.length)
    .map((c) => `${at(c)}: component "${c.name}" cites no requirement or ADR`);
  const vac = !m.architectureExists
    ? `no ${ARCHITECTURE_FILE} yet`
    : m.components.length
      ? null
      : `${ARCHITECTURE_FILE} has no components`;
  return result(
    "plan",
    "architecture-citations",
    problems,
    `${m.components.length} component(s), each citing a requirement or ADR`,
    vac,
  );
}

// ─── Build stage ──────────────────────────────────────────────────────────────

export type TrailerFacts =
  | { state: "ok"; commits: CommitTrailers[] }
  | { state: "none"; reason: string }
  | { state: "unknown"; reason: string };

export interface Manifest {
  file: string;
  name: string | null;
  deps: Array<{ name: string; spec: string }>;
}

export interface BuildFacts {
  trailers: TrailerFacts;
  manifests: Manifest[];
  /** ADR and architecture texts that may account for a dependency. */
  accounting: Doc[];
}

export function checkTrailerItems(m: Model, facts: TrailerFacts): CheckResult {
  if (facts.state === "unknown")
    return {
      stage: "build",
      name: "trailer-items",
      state: "unknown",
      summary: `could not ask: ${facts.reason}`,
      details: [],
    };
  if (facts.state === "none")
    return {
      stage: "build",
      name: "trailer-items",
      state: "vacuous",
      summary: facts.reason,
      details: [],
    };
  const k = knownIds(m);
  const problems: string[] = [];
  let n = 0;
  for (const c of facts.commits)
    for (const key of ["Progress", "Closes"])
      for (const v of trailerValues(c.trailers, key)) {
        n++;
        const id = trailerItemId(v);
        if (!id || !k.items.has(id))
          problems.push(
            `${c.commit.slice(0, 10)} "${c.subject}": ${key}: ${id ?? "(empty)"} names no item in docs/plan/items`,
          );
      }
  return result(
    "build",
    "trailer-items",
    problems,
    `${n} Progress/Closes trailer(s) in ${facts.commits.length} commit(s), all name items`,
    n ? null : `no Progress/Closes trailer in ${facts.commits.length} commit(s)`,
  );
}

function mentions(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(?<![\\w@/.-])${esc}(?![\\w/-])`, "i").test(text);
}

export function checkDependencies(facts: BuildFacts): CheckResult {
  const internal = new Set(facts.manifests.map((mf) => mf.name).filter((x): x is string => !!x));
  const text = facts.accounting.map((d) => stripFences(d.text)).join("\n");
  const problems: string[] = [];
  let n = 0;
  for (const mf of facts.manifests)
    for (const d of mf.deps) {
      if (internal.has(d.name) || d.spec.startsWith("workspace:")) continue;
      n++;
      if (!mentions(text, d.name))
        problems.push(
          `${mf.file}: ${d.name} is accounted for by no ADR or ${ARCHITECTURE_FILE} entry`,
        );
    }
  return result(
    "build",
    "dependencies",
    problems,
    `${n} third-party dependenc(ies), all accounted for`,
    n ? null : "no third-party dependency",
  );
}

// ─── Gathering build facts (git, files) ───────────────────────────────────────

export function gatherTrailers(root: string): TrailerFacts {
  if (!isRepo(root)) {
    const probe = git(root, ["--version"]);
    return {
      state: "unknown",
      reason: probe.ok ? `${root} is not a git repository` : probe.reason,
    };
  }
  if (!hasHead(root)) return { state: "none", reason: "no commits yet" };
  const r = logTrailers(root, ["HEAD"]);
  return r.ok ? { state: "ok", commits: r.commits } : { state: "unknown", reason: r.reason };
}

function workspaceGlobs(root: string): string[] {
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

export function readManifests(root: string): Manifest[] {
  const files = ["package.json"];
  for (const g of workspaceGlobs(root)) {
    if (g.startsWith("!")) continue;
    if (g.endsWith("/*")) {
      const dir = join(root, g.slice(0, -2));
      if (!existsSync(dir)) continue;
      for (const n of readdirSync(dir).sort())
        if (existsSync(join(dir, n, "package.json")))
          files.push(`${g.slice(0, -2)}/${n}/package.json`);
    } else if (existsSync(join(root, g, "package.json"))) files.push(`${g}/package.json`);
  }
  const out: Manifest[] = [];
  for (const f of files) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(join(root, f), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const deps: Manifest["deps"] = [];
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const block = pkg[field];
      if (block && typeof block === "object")
        for (const [name, spec] of Object.entries(block as Record<string, unknown>))
          deps.push({ name, spec: String(spec) });
    }
    out.push({ file: f, name: typeof pkg.name === "string" ? pkg.name : null, deps });
  }
  return out;
}

export function readAccounting(root: string, dirs: Dirs): Doc[] {
  const docs: Doc[] = [];
  const adrDir = join(root, dirs.adr);
  if (existsSync(adrDir))
    for (const n of readdirSync(adrDir).sort())
      if (n.endsWith(".md"))
        docs.push({ file: `${dirs.adr}/${n}`, text: readFileSync(join(adrDir, n), "utf8") });
  const arch = join(root, ARCHITECTURE_FILE);
  if (existsSync(arch)) docs.push({ file: ARCHITECTURE_FILE, text: readFileSync(arch, "utf8") });
  return docs;
}

export function gatherBuildFacts(root: string, dirs: Dirs): BuildFacts {
  return {
    trailers: gatherTrailers(root),
    manifests: readManifests(root),
    accounting: readAccounting(root, dirs),
  };
}

// ─── The census ───────────────────────────────────────────────────────────────

export function runCensus(m: Model, stage: Stage, build?: BuildFacts): CheckResult[] {
  const upto = STAGES.indexOf(stage);
  const out: CheckResult[] = [
    checkUniqueIds(m),
    checkReferences(m),
    checkWithdrawn(m),
    checkRequirementJourneys(m),
    checkJourneySteps(m),
    checkJourneyPersona(m),
    checkFeaturePersonas(m),
    checkPersonaJourneys(m),
    checkActors(m),
    checkProvisional(m),
    checkEntities(m),
    checkSenders(m),
    checkTriggers(m),
    checkAccessModel(m),
  ];
  if (upto >= 1)
    out.push(
      checkItemsCite(m),
      checkMvpCoverage(m),
      checkDependsCycle(m),
      checkPendingBlocks(m),
      checkArchitecture(m),
    );
  if (upto >= 2 && build) out.push(checkTrailerItems(m, build.trailers), checkDependencies(build));
  return out;
}

export function verdict(
  results: CheckResult[],
  allowUnknown: boolean,
): { ok: boolean; failed: number; unknown: number } {
  const failed = results.filter((r) => r.state === "fail").length;
  const unknown = results.filter((r) => r.state === "unknown").length;
  return { ok: failed === 0 && (unknown === 0 || allowUnknown), failed, unknown };
}

const LABEL: Record<CheckState, string> = {
  pass: "pass",
  fail: "FAIL",
  warn: "warn",
  vacuous: "vacuous",
  unknown: "COULD NOT ASK",
};

export function formatTable(results: CheckResult[], stage: Stage): string[] {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(
      `  ${r.stage.padEnd(13)} ${r.name.padEnd(24)} ${LABEL[r.state].padEnd(13)} ${r.summary}`.trimEnd(),
    );
    for (const d of r.details) lines.push(`      ${d}`);
  }
  const upto = STAGES.indexOf(stage);
  for (const s of STAGES.slice(upto + 1))
    lines.push(
      `  ${s.padEnd(13)} ${"(all)".padEnd(24)} ${"not run".padEnd(13)} stage ${s} not reached`,
    );
  return lines;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const allowUnknown = argv.includes("--allow-unknown");
  const si = argv.indexOf("--stage");
  const forced = si >= 0 ? argv[si + 1] : undefined;
  if (si >= 0 && !STAGES.includes(forced as Stage)) {
    console.error(`plan:check: --stage takes one of ${STAGES.join(", ")}`);
    return 2;
  }
  const root = findRoot();
  if (!root) {
    console.error("plan:check: could not find sdlc.config.ts above the current directory");
    return 2;
  }
  let dirs: Dirs = DEFAULT_DIRS;
  try {
    const cfg = await loadConfig(root);
    dirs = { requirements: cfg.dirs.requirements, plan: cfg.dirs.plan, adr: cfg.dirs.adr };
  } catch (e) {
    console.log(
      `plan:check: could not load sdlc.config.ts (${(e as Error).message}); using the default directories`,
    );
  }
  const detected = detectStage(root, dirs);
  const stage = (forced as Stage | undefined) ?? detected.stage;
  const model = loadModel(root, dirs);
  const build = STAGES.indexOf(stage) >= 2 ? gatherBuildFacts(root, dirs) : undefined;
  const results = runCensus(model, stage, build);
  console.log(`plan:check: stage ${stage} (${forced ? "--stage" : `auto: ${detected.reason}`})`);
  for (const l of formatTable(results, stage)) console.log(l);
  const v = verdict(results, allowUnknown);
  const vac = results.filter((r) => r.state === "vacuous").length;
  if (v.ok) {
    const extra = v.unknown ? `; ${v.unknown} could not ask (allowed by --allow-unknown)` : "";
    console.log(`plan:check: passed (${results.length} checks, ${vac} vacuous${extra})`);
    return 0;
  }
  const why = [
    v.failed ? `${v.failed} failed` : "",
    v.unknown ? `${v.unknown} could not ask (pass --allow-unknown to accept)` : "",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`plan:check: FAILED (${why})`);
  return 1;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
