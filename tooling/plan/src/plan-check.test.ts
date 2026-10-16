import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIXTURES,
  cleanup,
  commit,
  copyFixture,
  initRepo,
  tempDir,
  write,
} from "./__fixtures__/plan/temp-repo.ts";
import {
  checkDependencies,
  checkTrailerItems,
  findCycles,
  formatTable,
  gatherBuildFacts,
  gatherTrailers,
  readManifests,
  runCensus,
  verdict,
} from "./plan-check.mts";
import type { CheckResult } from "./plan-check.mts";
import type { Stage } from "./plan-lib.mts";
import { DEFAULT_DIRS, detectStage, loadModel } from "./plan-lib.mts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop() ?? "");
});

/** The good fixture with edits applied: path → new text, a transform, or null to delete. */
function mutated(edits: Record<string, string | ((t: string) => string) | null>): string {
  const d = copyFixture("good");
  dirs.push(d);
  for (const [p, e] of Object.entries(edits)) {
    const file = join(d, p);
    if (e === null) rmSync(file);
    else if (typeof e === "string") write(d, p, e);
    else writeFileSync(file, e(readFileSync(file, "utf8")));
  }
  return d;
}

function check(root: string, name: string, stage: Stage = "plan"): CheckResult {
  const r = runCensus(loadModel(root), stage).find((x) => x.name === name);
  if (!r) throw new Error(`no check ${name}`);
  return r;
}

const F02 = "docs/requirements/features/F02-attendance.md";
const J = "docs/requirements/journeys.md";
const P = "docs/requirements/personas.md";

describe("the good fixture", () => {
  it("passes every check up to the plan stage", () => {
    const results = runCensus(loadModel(join(FIXTURES, "good")), "plan");
    expect(results.filter((r) => r.state !== "pass")).toEqual([]);
    expect(results).toHaveLength(22);
  });
  it("is detected at the plan stage", () => {
    expect(detectStage(join(FIXTURES, "good")).stage).toBe("plan");
  });
});

describe("the empty starter", () => {
  it("is pre-discovery, and says discovery has not started rather than passing vacuously", () => {
    const root = join(FIXTURES, "empty");
    expect(detectStage(root)).toMatchObject({ stage: "pre-discovery" });
    const results = runCensus(loadModel(root), "pre-discovery");
    expect(results.map((r) => [r.name, r.state])).toEqual([
      ["unique-ids", "pass"],
      ["references", "pass"],
      ["discovery", "not started"],
    ]);
    expect(verdict(results, false).ok).toBe(true);
    const table = formatTable(results, "pre-discovery");
    expect(
      table.some((l) => l.includes("NOT STARTED") && l.includes("discovery not started")),
    ).toBe(true);
    expect(table.filter((l) => l.includes("not run"))).toHaveLength(3);
  });
  it("fails the requirements stage, naming every missing discovery output", () => {
    const results = runCensus(loadModel(join(FIXTURES, "empty")), "requirements");
    expect(verdict(results, false).ok).toBe(false);
    const outputs = results.find((r) => r.name === "discovery-outputs");
    expect(outputs?.state).toBe("fail");
    for (const f of ["brd.md", "prd.md", "personas.md", "journeys.md", "glossary.md", "review.md"])
      expect(outputs?.details.join("\n")).toContain(`docs/requirements/${f} is missing`);
    expect(outputs?.details.join("\n")).toContain("features/ holds no feature file");
    expect(results.find((r) => r.state === "not started")).toBeUndefined();
  });
  it("fails the plan stage too", () => {
    const results = runCensus(loadModel(join(FIXTURES, "empty")), "plan");
    expect(verdict(results, false).ok).toBe(false);
  });
});

describe("stage detection", () => {
  const empty = () => {
    const d = copyFixture("empty");
    dirs.push(d);
    return d;
  };
  it("any one discovery output moves the starter to the requirements stage", () => {
    const d = empty();
    write(d, "docs/requirements/glossary.md", "# Glossary\n");
    expect(detectStage(d)).toMatchObject({ stage: "requirements" });
    const f = empty();
    write(f, "docs/requirements/features/F01-x.md", "# F01 X\n");
    expect(detectStage(f).stage).toBe("requirements");
  });
  it("project-brief.md and sources/ are not discovery outputs", () => {
    const d = empty();
    write(d, "docs/requirements/project-brief.md", "# Brief\n");
    write(d, "docs/requirements/sources/notes.md", "imported\n");
    expect(detectStage(d).stage).toBe("pre-discovery");
  });
  it("a package-only project reaches the build stage", () => {
    const d = empty();
    write(d, "pnpm-workspace.yaml", 'packages:\n  - "tooling/*"\n  - "apps/*"\n  - "packages/*"\n');
    write(d, "tooling/plan/package.json", "{}");
    expect(detectStage(d).stage).toBe("pre-discovery");
    write(d, "packages/core/package.json", JSON.stringify({ name: "@acme/core" }));
    expect(detectStage(d)).toMatchObject({ stage: "build" });
    expect(detectStage(d).reason).toContain("packages/core");
  });
  it("docs/plan/README.md can declare the build stage", () => {
    const d = empty();
    write(d, "docs/plan/README.md", "# Plan\n\nStage: build\n");
    expect(detectStage(d).stage).toBe("build");
    write(d, "docs/plan/README.md", "# Plan\n\n```\nStage: build\n```\n");
    expect(detectStage(d).stage).toBe("pre-discovery");
  });
});

describe("discovery outputs and the verdict", () => {
  const R = "docs/requirements/review.md";
  it("discovery-outputs: a missing glossary, an empty BRD, a personas.md with no persona", () => {
    const d = mutated({
      "docs/requirements/glossary.md": null,
      "docs/requirements/brd.md": "<!-- todo -->\n",
      [P]: "# Personas\n\nNobody yet.\n",
    });
    const r = check(d, "discovery-outputs", "requirements");
    expect(r.state).toBe("fail");
    const text = r.details.join("\n");
    expect(text).toContain("glossary.md is missing");
    expect(text).toContain("brd.md is empty");
    expect(text).toContain("personas.md defines no persona");
  });
  it("discovery-outputs: features with no requirement", () => {
    const d = mutated({
      [F02]: null,
      "docs/requirements/features/F01-sessions.md": "# F01 Sessions\n\nPersonas: @organizer\n",
    });
    expect(check(d, "discovery-outputs", "requirements").details.join()).toContain(
      "defines no requirement",
    );
  });
  it("review-verdict: absent, malformed, or doubled fails", () => {
    const none = mutated({ [R]: "# Review\n\nLooks fine.\n" });
    expect(check(none, "review-verdict", "requirements").details.join()).toContain('no "Verdict:');
    const bad = mutated({ [R]: "# Review\n\nVerdict: ready to plan\n" });
    expect(check(bad, "review-verdict", "requirements").details.join()).toContain(
      "is not a verdict",
    );
    const two = mutated({ [R]: "Verdict: ready-to-plan\n\nVerdict: not-ready\n" });
    expect(check(two, "review-verdict", "requirements").details.join()).toContain("keep one");
    const fenced = mutated({ [R]: "```\nVerdict: ready-to-plan\n```\n" });
    expect(check(fenced, "review-verdict", "requirements").state).toBe("fail");
  });
  it("review-verdict: not-ready fails; ready-pending-decisions passes requirements but not plan", () => {
    const notReady = mutated({ [R]: "Verdict: not-ready\n" });
    expect(check(notReady, "review-verdict", "requirements").state).toBe("fail");
    const pending = mutated({ [R]: "- **Verdict:** ready-pending-decisions\n" });
    expect(check(pending, "review-verdict", "requirements").state).toBe("pass");
    expect(verdict(runCensus(loadModel(pending), "requirements"), false).ok).toBe(true);
    expect(check(pending, "plan-readiness").state).toBe("fail");
    const assumed = mutated({ [R]: "Verdict: ready-with-assumptions\n" });
    expect(check(assumed, "plan-readiness").state).toBe("pass");
  });
});

describe("requirements stage, each check tripped", () => {
  it("unique-ids: a requirement defined twice", () => {
    const d = mutated({
      [F02]: (t) => t.replace("### F02-R02 Export attendance", "### F02-R01 Export attendance"),
    });
    expect(check(d, "unique-ids").state).toBe("fail");
  });
  it("unique-ids: two items with one ID", () => {
    const d = mutated({
      "docs/plan/items/F02-001-other.md":
        "---\nid: F02-001\ntitle: dup\nrequirements: [F02-R01]\n---\n",
    });
    expect(check(d, "unique-ids").details.join()).toContain("item F02-001 is defined twice");
  });
  it("references: a missing requirement, persona and item", () => {
    const d = mutated({
      "docs/plan/items/F01-001-create-session.md": (t) =>
        t.replace("[F01-R01]", "[F01-R09]").replace("[X-000]", "[X-099]"),
      [J]: (t) => t.replace("Persona: @organizer", "Persona: @organiser"),
    });
    const r = check(d, "references");
    expect(r.state).toBe("fail");
    const text = r.details.join("\n");
    expect(text).toContain("F01-R09");
    expect(text).toContain("X-099");
    expect(text).toContain("@organiser");
  });
  it("references: ignores sources/ and fenced code", () => {
    expect(check(join(FIXTURES, "good"), "references").state).toBe("pass");
  });
  it("withdrawn-ids: a withdrawn requirement cited by a journey", () => {
    const d = mutated({ [J]: (t) => t.replace("(F02-R02)", "(F02-R02, F01-R03)") });
    expect(check(d, "withdrawn-ids").state).toBe("fail");
  });
  it("requirement-journeys: a requirement no journey serves", () => {
    const d = mutated({ [J]: (t) => t.replace("2. Exports attendance (F02-R02)", "") });
    expect(check(d, "requirement-journeys").details.join()).toContain("F02-R02");
  });
  it("journey-steps: a step citing no requirement", () => {
    const d = mutated({
      [J]: (t) =>
        t.replace(
          "2. Exports attendance (F02-R02)",
          "2. Exports attendance (F02-R02)\n3. Goes home",
        ),
    });
    expect(check(d, "journey-steps").state).toBe("fail");
  });
  it("journey-persona: a journey naming two personas", () => {
    const d = mutated({
      [J]: (t) => t.replace("Persona: @organizer", "Persona: @organizer, @attendee"),
    });
    expect(check(d, "journey-persona").state).toBe("fail");
  });
  it("feature-personas: a feature naming none", () => {
    const d = mutated({ [F02]: (t) => t.replace("Personas: @attendee", "Personas:") });
    expect(check(d, "feature-personas").details.join()).toContain("F02");
  });
  it("persona-journeys: a persona with no journey", () => {
    const d = mutated({ [P]: (t) => `${t}\n## @admin — runs the product\n` });
    expect(check(d, "persona-journeys").details.join()).toContain("@admin");
  });
  it("actors: an actor that is neither a persona nor system:", () => {
    const d = mutated({ [F02]: (t) => t.replace("Actor: @organizer", "Actor: the manager") });
    expect(check(d, "actors").details.join()).toContain("the manager");
  });
  it("actors: an unregistered persona", () => {
    const d = mutated({ [F02]: (t) => t.replace("Actor: @organizer", "Actor: @manager") });
    expect(check(d, "actors").state).toBe("fail");
  });
  it("provisional-personas: reported with its Q-, failing without one", () => {
    const ok = mutated({
      [P]: (t) =>
        t.replace("Goals: find a session", "Status: provisional (Q-001)\n\nGoals: find a session"),
    });
    const r = check(ok, "provisional-personas");
    expect(r.state).toBe("warn");
    expect(r.details.join()).toContain("Q-001");
    expect(verdict([r], false).ok).toBe(true);
    const bad = mutated({
      [P]: (t) =>
        t.replace("Goals: find a session", "Status: provisional\n\nGoals: find a session"),
    });
    expect(check(bad, "provisional-personas").state).toBe("fail");
  });
  it("entities: an entity the domain model does not define", () => {
    const d = mutated({ [F02]: (t) => t.replace("Data: `Rsvp`", "Data: Ticket") });
    expect(check(d, "entities").details.join()).toContain("Ticket");
  });
  it("lifecycle-senders: an event with no sender", () => {
    const d = mutated({
      "docs/requirements/domain-model.md": (t) =>
        t.replace(
          "- SEND: SCHEDULED → SENT · sender: system:scheduler",
          "- SEND: SCHEDULED → SENT",
        ),
    });
    expect(check(d, "lifecycle-senders").details.join()).toContain("Reminder.SEND");
  });
  it("technology-triggers: decided without an ADR, pending without requirements", () => {
    const d = mutated({
      "docs/requirements/technology.md": (t) =>
        t
          .replace("| decided | ADR-001 |", "| decided | — |")
          .replace(/\| SMS provider\s*\| F01-R02\s*\|/, "| SMS provider | |"),
    });
    const r = check(d, "technology-triggers");
    expect(r.details).toHaveLength(2);
  });
  it("technology-triggers: pending without blocks passes at the requirements stage", () => {
    const d = mutated({
      "docs/requirements/technology.md": (t) => t.replace("| F01-002 |", "| |"),
    });
    expect(check(d, "technology-triggers", "requirements").state).toBe("pass");
    expect(check(d, "pending-triggers-block").state).toBe("fail");
  });
  it("access-model: tenancy open or undeclared fails; absent fails discovery-outputs", () => {
    const d = mutated({ "docs/requirements/access-model.md": "# Access\n\nTenancy: open\n" });
    expect(check(d, "access-model").state).toBe("fail");
    const silent = mutated({ "docs/requirements/access-model.md": "# Access\n\nRoles: admin\n" });
    expect(check(silent, "access-model").details.join()).toContain("declares no tenancy");
    const marker = mutated({
      "docs/requirements/access-model.md":
        "# Access\n<!-- idea: section=tenancy state=decided -->\n",
    });
    expect(check(marker, "access-model").state).toBe("pass");
    const gone = mutated({ "docs/requirements/access-model.md": null });
    expect(check(gone, "discovery-outputs").details.join()).toContain("access-model.md is missing");
    expect(verdict(runCensus(loadModel(gone), "requirements"), false).ok).toBe(false);
  });
});

describe("plan stage, each check tripped", () => {
  it("items-cite-requirements: a feature item citing none", () => {
    const d = mutated({ "docs/plan/items/F02-001-rsvp.md": (t) => t.replace("[F02-R01]", "[]") });
    expect(check(d, "items-cite-requirements").state).toBe("fail");
  });
  it("mvp-coverage: an MVP requirement no item covers", () => {
    const d = mutated({
      "docs/plan/items/F02-001-rsvp.md": (t) =>
        t.replace("estimate: 2", "estimate: 2\ndropped: 2026-10-15 not needed"),
    });
    expect(check(d, "mvp-coverage").details.join()).toContain("F02-R01");
  });
  it("depends-cycle", () => {
    const d = mutated({
      "docs/plan/items/F01-001-create-session.md": (t) => t.replace("[X-000]", "[F02-001]"),
    });
    expect(check(d, "depends-cycle").details.join()).toContain("F01-001");
    expect(
      findCycles(
        new Map([
          ["A", ["B"]],
          ["B", ["A"]],
          ["C", ["C"]],
        ]),
      ),
    ).toHaveLength(2);
  });
  it("architecture-citations: a component citing nothing", () => {
    const d = mutated({
      "docs/architecture.md": (t) => t.replace("Decided in ADR-001.", "A mailer."),
    });
    expect(check(d, "architecture-citations").details.join()).toContain("Email");
  });
});

describe("build stage", () => {
  it("trailer-items: a Progress: naming no item", () => {
    const m = loadModel(join(FIXTURES, "good"));
    const commits = [
      {
        commit: "a".repeat(40),
        time: 0,
        subject: "ok",
        trailers: [{ key: "Closes", value: "f01-001" }],
      },
      {
        commit: "b".repeat(40),
        time: 0,
        subject: "bad",
        trailers: [{ key: "Progress", value: "F07-001 half" }],
      },
    ];
    const r = checkTrailerItems(m, { state: "ok", commits });
    expect(r.state).toBe("fail");
    expect(r.details.join()).toContain("F07-001");
    expect(checkTrailerItems(m, { state: "ok", commits: commits.slice(0, 1) }).state).toBe("pass");
  });
  it("trailer-items: could not ask is its own state, and holds the verdict", () => {
    const m = loadModel(join(FIXTURES, "good"));
    const r = checkTrailerItems(m, { state: "unknown", reason: "git is not installed" });
    expect(r.state).toBe("unknown");
    expect(verdict([r], false).ok).toBe(false);
    expect(verdict([r], true).ok).toBe(true);
  });
  it("trailer-items: reads a real repository, and a non-repository could not ask", () => {
    const d = initRepo(tempDir());
    dirs.push(d);
    expect(gatherTrailers(d)).toMatchObject({ state: "none" });
    commit(d, "x\n\nProgress: X-000 started");
    const t = gatherTrailers(d);
    expect(t.state).toBe("ok");
    const plain = tempDir();
    dirs.push(plain);
    expect(gatherTrailers(plain).state).toBe("unknown");
  });
  it("dependencies: only a Dependencies: line accounts; every field and workspace package is read", () => {
    const d = mutated({
      "package.json": JSON.stringify({
        devDependencies: { typescript: "^5", vitest: "^3", "left-pad": "^1" },
      }),
      "pnpm-workspace.yaml": 'packages:\n  - "tooling/*"\n  - "apps/*"\n',
      "tooling/plan/package.json": JSON.stringify({
        name: "@ai-sdlc/plan",
        dependencies: { "@ai-sdlc/core": "workspace:*" },
      }),
      "tooling/core/package.json": JSON.stringify({ name: "@ai-sdlc/core" }),
      "apps/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: { "@acme/db": "workspace:*", eslint: "^9", "@ai-sdlc/plan": "0.1.0" },
        peerDependencies: { react: "^19" },
        optionalDependencies: { fsevents: "^2" },
      }),
    });
    expect(readManifests(d).map((m) => m.file)).toEqual([
      "package.json",
      "tooling/core/package.json",
      "tooling/plan/package.json",
      "apps/web/package.json",
    ]);
    const r = checkDependencies(gatherBuildFacts(d, DEFAULT_DIRS));
    expect(r.state).toBe("fail");
    expect(r.details).toEqual([
      'package.json devDependencies: left-pad is accounted for by no "Dependencies:" line in an ADR or docs/architecture.md',
      'apps/web/package.json peerDependencies: react is accounted for by no "Dependencies:" line in an ADR or docs/architecture.md',
      'apps/web/package.json optionalDependencies: fsevents is accounted for by no "Dependencies:" line in an ADR or docs/architecture.md',
    ]);
  });
  it("dependencies: a Dependencies: line in an ADR or the architecture accounts; a fenced one does not", () => {
    const d = mutated({
      "package.json": JSON.stringify({ dependencies: { "@scope/pkg": "^1", zod: "^4", pg: "^8" } }),
      "docs/adr/ADR-002-data.md":
        "# ADR-002\n\nDependencies: `@scope/pkg`\n\n```\nDependencies: pg\n```\n",
      "docs/architecture.md": (t) => `${t}\nDependencies: zod\n`,
    });
    expect(checkDependencies(gatherBuildFacts(d, DEFAULT_DIRS)).details).toEqual([
      'package.json dependencies: pg is accounted for by no "Dependencies:" line in an ADR or docs/architecture.md',
    ]);
  });
});
