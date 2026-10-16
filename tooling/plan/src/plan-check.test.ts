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
import { DEFAULT_DIRS, loadModel } from "./plan-lib.mts";

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

function check(root: string, name: string, stage: "requirements" | "plan" = "plan"): CheckResult {
  const r = runCensus(loadModel(root), stage).find((x) => x.name === name);
  if (!r) throw new Error(`no check ${name}`);
  return r;
}

const F02 = "docs/requirements/features/F02-attendance.md";
const J = "docs/requirements/journeys.md";
const P = "docs/requirements/personas.md";

describe("the good fixture", () => {
  it("passes every requirements and plan check", () => {
    const results = runCensus(loadModel(join(FIXTURES, "good")), "plan");
    expect(results.filter((r) => r.state !== "pass")).toEqual([]);
    expect(results).toHaveLength(19);
  });
});

describe("the empty starter", () => {
  it("passes vacuously, with a line per check saying so", () => {
    const results = runCensus(loadModel(join(FIXTURES, "empty")), "requirements");
    expect(results).toHaveLength(14);
    expect(results.every((r) => r.state === "vacuous")).toBe(true);
    expect(verdict(results, false).ok).toBe(true);
    const table = formatTable(results, "requirements");
    expect(table.filter((l) => l.includes("vacuous"))).toHaveLength(14);
    expect(table.some((l) => l.includes("not run"))).toBe(true);
  });
  it("also passes the plan stage", () => {
    const results = runCensus(loadModel(join(FIXTURES, "empty")), "plan");
    expect(verdict(results, false).ok).toBe(true);
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
  it("access-model: tenancy open is blocking; absent is vacuous", () => {
    const d = mutated({ "docs/requirements/access-model.md": "# Access\n\nTenancy: open\n" });
    expect(check(d, "access-model").state).toBe("fail");
    const gone = mutated({ "docs/requirements/access-model.md": null });
    expect(check(gone, "access-model").state).toBe("vacuous");
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
  it("dependencies: one no ADR accounts for; workspace packages are exempt", () => {
    const d = mutated({
      "package.json": JSON.stringify({
        devDependencies: { typescript: "^5", vitest: "^3", "left-pad": "^1" },
      }),
      "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
      "apps/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: { "@acme/db": "workspace:*", eslint: "^9" },
      }),
    });
    expect(readManifests(d).map((m) => m.file)).toEqual(["package.json", "apps/web/package.json"]);
    const r = checkDependencies(gatherBuildFacts(d, DEFAULT_DIRS));
    expect(r.state).toBe("fail");
    expect(r.details).toEqual([
      "package.json: left-pad is accounted for by no ADR or docs/architecture.md entry",
    ]);
  });
});
