import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIXTURES,
  cleanup,
  commit,
  initRepo,
  tempDir,
  write,
} from "./__fixtures__/plan/temp-repo.ts";
import {
  detectStage,
  extractIds,
  fieldsOf,
  fmList,
  loadModel,
  logTrailers,
  STAGES,
  parseAccessModel,
  parseDependencyLines,
  parseTenancy,
  parseVerdict,
  parseFrontmatter,
  parseJourneys,
  parsePersonas,
  parseTechnology,
  parseTrailerLines,
  planWritten,
  stripFences,
  trailerItemId,
  integrationRef,
} from "./plan-lib.mts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop() ?? "");
});

describe("parseFrontmatter", () => {
  it("reads scalars, inline and block lists, quotes and comments", () => {
    const fm = parseFrontmatter(
      "---\nid: F03-012\ntitle: \"Stop: reminders\"\nrequirements: [F03-R04, 'F03-R05']\npersonas: [@attendee]\ndepends:\n  - F03-010\n  - X-004\nestimate: 3   # never a guess\nanswered:\n---\n## Body\n",
    );
    expect(fm.present).toBe(true);
    expect(fm.data.id).toBe("F03-012");
    expect(fm.data.title).toBe("Stop: reminders");
    expect(fm.data.requirements).toEqual(["F03-R04", "F03-R05"]);
    expect(fm.data.personas).toEqual(["@attendee"]);
    expect(fm.data.depends).toEqual(["F03-010", "X-004"]);
    expect(fm.data.estimate).toBe("3");
    expect(fm.data.answered).toBeNull();
    expect(fm.body.trim()).toBe("## Body");
  });
  it("reports no frontmatter rather than guessing", () => {
    expect(parseFrontmatter("# Title\n").present).toBe(false);
    expect(fmList(null)).toEqual([]);
    expect(fmList("a, b")).toEqual(["a", "b"]);
  });
});

describe("fieldsOf", () => {
  it("splits several fields on one line", () => {
    expect(fieldsOf("Actor: system:scheduler · Trigger: daily · Preconditions: none")).toEqual([
      { label: "actor", value: "system:scheduler" },
      { label: "trigger", value: "daily" },
      { label: "preconditions", value: "none" },
    ]);
    expect(fieldsOf("Personas: @a, @b       Journeys: J1, J2").map((f) => f.label)).toEqual([
      "personas",
      "journeys",
    ]);
    expect(fieldsOf("**Actor:** @a")).toEqual([{ label: "actor", value: "@a" }]);
    expect(fieldsOf("Metadata: x")).toEqual([]);
    expect(fieldsOf("Personas: @a, @b Journeys: J1").map((f) => f.value)).toEqual(["@a, @b", "J1"]);
    expect(fieldsOf("the journeys: are many")).toEqual([]);
  });
});

describe("extractIds", () => {
  it("finds every kind and ignores emails and package scopes", () => {
    const ids = extractIds(
      "F03-R07 and f03-012, J12, Q-007, ADR-004, F03, X-001, @organizer, a@b.com, @types/node",
    );
    expect(ids.requirements).toEqual(["F03-R07"]);
    expect(ids.items).toEqual(["F03-012", "X-001"]);
    expect(ids.features).toEqual(["F03"]);
    expect(ids.journeys).toEqual(["J12"]);
    expect(ids.questions).toEqual(["Q-007"]);
    expect(ids.adrs).toEqual(["ADR-004"]);
    expect(ids.personas).toEqual(["organizer"]);
  });
  it("is blind to fenced code", () => {
    expect(extractIds(stripFences("```\nF01-R01\n```\nF02-R02")).requirements).toEqual(["F02-R02"]);
  });
});

describe("document parsers", () => {
  it("parses the good fixture", () => {
    const m = loadModel(join(FIXTURES, "good"));
    expect(m.personas.map((p) => p.slug)).toEqual(["organizer", "attendee"]);
    expect(m.features.map((f) => [f.id, f.personas, f.journeys, f.phase])).toEqual([
      ["F01", ["organizer", "attendee"], ["J1", "J2"], "MVP"],
      ["F02", ["attendee"], ["J2"], "MVP"],
    ]);
    const r = Object.fromEntries(m.requirements.map((x) => [x.id, x]));
    expect(r["F01-R01"]?.actors).toEqual(["@organizer"]);
    expect(r["F01-R01"]?.entities).toEqual(["Session"]);
    expect(r["F01-R02"]?.entities).toEqual(["Session", "Reminders"]);
    expect(r["F01-R03"]?.withdrawn).toBe(true);
    expect(r["F01-R04"]?.outOfScope).toBe(true);
    expect(r["F02-R02"]?.mvp).toBe(false);
    expect(r["F02-R01"]?.entities).toEqual(["Rsvp"]);
    expect(m.journeys.map((j) => [j.id, j.personas, j.steps.map((s) => s.requirements)])).toEqual([
      ["J1", ["organizer"], [["F01-R01"], ["F02-R02"]]],
      ["J2", ["attendee"], [["F02-R01"], ["F01-R02"]]],
    ]);
    expect(m.entities.map((e) => e.name)).toEqual(["Session", "Reminder", "Rsvp"]);
    expect(m.entities[1]?.events[0]).toMatchObject({ name: "SEND", senders: ["system:scheduler"] });
    expect(m.triggers.map((t) => [t.name, t.status, t.adrs, t.blocks.items])).toEqual([
      ["Email notifications", "decided", ["ADR-001"], []],
      ["SMS provider", "pending", [], ["F01-002"]],
    ]);
    expect(m.components.map((c) => c.name)).toEqual(["Web app", "Email"]);
    expect(m.items.map((i) => i.id)).toEqual(["F01-001", "F01-002", "F02-001", "X-000"]);
    expect(m.items.find((i) => i.id === "F01-002")?.personas).toEqual(["attendee"]);
    expect(m.questions[0]).toMatchObject({ id: "Q-001", blocks: ["F02-001"], answered: null });
    expect(m.adrs).toEqual(["ADR-000", "ADR-001"]);
    expect(m.docs.some((d) => d.file.includes("sources"))).toBe(false);
  });

  it("reads a provisional persona and the question that settles it", () => {
    const [p] = parsePersonas("## @guest — maybe\n\nStatus: provisional, see Q-003\n", "p.md");
    expect(p).toMatchObject({ slug: "guest", provisional: true, settledBy: ["Q-003"] });
    const [h] = parsePersonas("### `@host` (provisional)\n\nSettled by Q-004.\n", "p.md");
    expect(h).toMatchObject({ slug: "host", provisional: true, settledBy: ["Q-004"] });
  });

  it("takes the persona from the heading when no Persona: field exists", () => {
    const [j] = parseJourneys("## J3 @guest browses\n\n- looks (F01-R01)\n", "j.md");
    expect(j?.personas).toEqual(["guest"]);
  });

  it("reads technology triggers written as headings", () => {
    const t = parseTechnology(
      "## Search\n\nStatus: pending\nRequirements: F02-R01\nBlocks: F02-003\n\n### Maps\n\nStatus: decided (ADR-007)\n",
      "t.md",
    );
    expect(t.map((x) => [x.name, x.status, x.requirements, x.blocks.items, x.adrs])).toEqual([
      ["Search", "pending", ["F02-R01"], ["F02-003"], []],
      ["Maps", "decided", [], [], ["ADR-007"]],
    ]);
  });

  it("knows an open tenancy", () => {
    expect(parseAccessModel("Tenancy: open — waiting on Q-002\n", "a.md")).toEqual({
      file: "a.md",
      line: 1,
    });
    expect(parseAccessModel("<!-- idea: section=tenancy state=open -->\n", "a.md")).not.toBeNull();
    expect(parseAccessModel("Tenancy: multi-tenant, shared schema\n", "a.md")).toBeNull();
  });
});

describe("verdict, tenancy and Dependencies: lines", () => {
  it("reads exactly the documented verdict form", () => {
    const r = parseVerdict(
      "# Review\n\nVerdict: ready-to-plan\n**Verdict:** not-ready\nVerdict: ready to plan\n<!-- Verdict: not-ready -->\n",
      "r.md",
    );
    expect(r.verdicts.map((v) => [v.value, v.line])).toEqual([
      ["ready-to-plan", 3],
      ["not-ready", 4],
    ]);
    expect(r.malformed.map((m) => m.line)).toEqual([5]);
    expect(parseVerdict(null, "r.md").exists).toBe(false);
  });
  it("reads the declared tenancy", () => {
    expect(parseTenancy("Tenancy: per-user\n", "a.md")?.value).toBe("per-user");
    expect(parseTenancy("<!-- idea: section=tenancy state=decided -->\n", "a.md")?.value).toBe(
      "decided",
    );
    expect(parseTenancy("Roles: admin\n", "a.md")).toBeNull();
  });
  it("reads Dependencies: lines and nothing else", () => {
    expect(
      parseDependencyLines(
        "Uses typescript.\nDependencies: `@types/node`, eslint,\n- Dependencies: vitest\n```\nDependencies: pg\n```\n",
        "adr.md",
      ).map((d) => d.name),
    ).toEqual(["@types/node", "eslint", "vitest"]);
  });
});

describe("stage", () => {
  it("treats the starter's README as no plan yet", () => {
    expect(planWritten("# Plan\n\nWritten by `/plan`.\n")).toBe(false);
    expect(planWritten("# Plan\n\n## Milestones\n")).toBe(true);
    expect(planWritten("<!-- plan:placeholder -->\n## Milestones\n")).toBe(false);
    expect(detectStage(join(FIXTURES, "empty")).stage).toBe("pre-discovery");
    expect(detectStage(join(FIXTURES, "good")).stage).toBe("plan");
  });
  it("is pre-discovery until a discovery output exists", () => {
    expect(STAGES[0]).toBe("pre-discovery");
    const d = tempDir();
    dirs.push(d);
    expect(detectStage(d).stage).toBe("pre-discovery");
    write(d, "docs/requirements/review.md", "Verdict: not-ready\n");
    expect(detectStage(d).stage).toBe("requirements");
  });
  it("is build once apps/ holds an app", () => {
    const d = tempDir();
    dirs.push(d);
    write(d, "docs/plan/README.md", "## Milestones\n");
    write(d, "apps/web/package.json", "{}");
    expect(detectStage(d)).toMatchObject({ stage: "build" });
  });
});

describe("trailers", () => {
  it("parses interpret-trailers output and item IDs", () => {
    expect(
      parseTrailerLines("Progress: F03-012 covered x\nCo-Authored-By: A <a@b>\n  continued\n"),
    ).toEqual([
      { key: "Progress", value: "F03-012 covered x" },
      { key: "Co-Authored-By", value: "A <a@b> continued" },
    ]);
    expect(trailerItemId("f03-012: covered")).toBe("F03-012");
    expect(trailerItemId("  ")).toBeNull();
  });

  it("reads trailers through git, ignoring prose that quotes one", () => {
    const d = initRepo(tempDir());
    dirs.push(d);
    commit(
      d,
      "feat: x\n\nThe body says Closes: F09-009 in prose.\n\nProgress: F01-001 half\nCloses: F01-002",
    );
    const r = logTrailers(d, ["HEAD"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.commits[0]?.trailers).toEqual([
      { key: "Progress", value: "F01-001 half" },
      { key: "Closes", value: "F01-002" },
    ]);
  });

  it("falls back to the local integration branch and says so", () => {
    const d = initRepo(tempDir());
    dirs.push(d);
    commit(d, "init");
    expect(integrationRef(d, "dev")).toMatchObject({
      ref: "dev",
      note: expect.stringContaining("could not ask origin"),
    });
    expect(integrationRef(d, "nope")).toMatchObject({ ref: null });
  });
});
