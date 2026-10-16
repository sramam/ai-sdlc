import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  ConfigError,
  STARTER_MODULES,
  STARTER_SKILLS,
  findRoot,
  loadConfig,
  loadConfigAt,
  parseConfig,
  upstreamPaths,
  validateConfig,
} from "./config.mts";
import { SCHEMA_PATH, configSchema } from "./config-schema.mts";
import { exampleConfig } from "./config.test-helper.mts";
import type { SdlcConfig } from "./config.mts";

const REPO = join(import.meta.dirname, "..", "..", "..");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdlc-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const problems = (v: unknown): string[] => {
  const r = validateConfig(v);
  return r.ok ? [] : r.problems;
};
/** A complete config with one thing changed, as a plain value. */
const edited = (f: (c: Record<string, unknown>) => void): unknown => {
  const c = JSON.parse(JSON.stringify(exampleConfig())) as Record<string, unknown>;
  f(c);
  return c;
};

describe("the repository's own sdlc.config.json", () => {
  it("loads and validates", async () => {
    const c = await loadConfig(REPO);
    expect(c.branches.integration).toBe("dev");
    expect(c.ci.steps.find((s) => s.name === "trailers")?.history).toBe(true);
  });
});

describe("validation", () => {
  it("accepts a complete config, and every optional section", () => {
    expect(problems(exampleConfig())).toEqual([]);
    const full: SdlcConfig = exampleConfig((c) => {
      c.configVersion = 2;
      c.accounts = [{ name: "Manual", cli: null, check: [], manual: "owner signs in" }];
      c.ci.steps = [{ name: "t", run: "x", applies: "has-source", env: ["A"], history: true }];
      c.ci.container = { image: "node:24", engine: "podman", network: "none" };
      c.coverage.floors = { "packages/db": { lines: 95, branches: 90 } };
      c.modules = { replaced: ["journeys"] };
      c.localdb = { databases: [{ name: "app", migrate: "m", env: ["E"] }] };
      c.seeds = [{ app: "web", run: "s", database: "app", sizes: ["dev"] }];
    });
    expect(problems(full)).toEqual([]);
  });

  it("an unknown key is an error naming the key and where it is", () => {
    expect(problems(edited((c) => (c.journeys = {})))).toEqual(['(root): unknown key "journeys"']);
    expect(
      problems(
        edited((c) => {
          (c.ci as { steps: unknown[] }).steps = [
            { name: "a", run: "b", applies: "always", histroy: true },
          ];
        }),
      ),
    ).toEqual(['ci.steps[0]: unknown key "histroy"']);
  });

  it("a wrong type names the path", () => {
    expect(problems(edited((c) => (c.claimStaleDays = "7")))).toEqual([
      "claimStaleDays: expected a number, got string",
    ]);
    expect(
      problems(
        edited((c) => {
          (c.ci as { steps: unknown[] }).steps = [{ name: "a", run: 3, applies: "sometimes" }];
        }),
      ),
    ).toEqual([
      "ci.steps[0].run: expected a string, got number",
      'ci.steps[0].applies: expected one of "always", "has-apps", "has-packages", "has-source", "has-plan", got "sometimes"',
    ]);
    expect(problems(edited((c) => (c.accounts = [{ name: "x", cli: 1, check: [] }])))).toEqual([
      "accounts[0].cli: expected a string, got number",
    ]);
    expect(
      problems(edited((c) => (c.cadence = { progressReportWeekdays: [7], planSyncDays: 1 }))),
    ).toEqual(["cadence.progressReportWeekdays[0]: 7 is above the maximum 6"]);
  });

  it("a missing required key is named", () => {
    expect(problems(edited((c) => delete c.branches))).toEqual(["branches: required"]);
    expect(problems([])).toEqual(["(root): expected an object, got an array"]);
  });

  it("a replaced module must be one of the starter's", () => {
    expect(problems(edited((c) => (c.modules = { replaced: ["gaurds"] })))[0]).toMatch(
      /^modules\.replaced\[0\]: expected one of "core"/,
    );
  });

  it("a seed's database must be a declared localdb database", () => {
    expect(
      problems(edited((c) => (c.seeds = [{ app: "web", run: "s", database: "nope" }]))),
    ).toEqual(['seeds[0].database: "nope" is not a localdb.databases name']);
  });

  it("parseConfig throws a ConfigError naming every problem, and the source", () => {
    expect(() => parseConfig("{ nope", "x.json")).toThrow(
      /x\.json is not a valid configuration:\n {2}not valid JSON/,
    );
    try {
      parseConfig(JSON.stringify(edited((c) => ((c.a = 1), (c.b = 2)))));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toEqual([
        '(root): unknown key "a"',
        '(root): unknown key "b"',
      ]);
    }
  });
});

describe("finding and loading", () => {
  it("findRoot walks up to sdlc.config.json, and ignores a leftover sdlc.config.ts", () => {
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "a", "sdlc.config.ts"), "export default {}");
    expect(findRoot(sub)).not.toBe(join(dir, "a"));
    writeFileSync(join(dir, CONFIG_FILE), "{}");
    expect(findRoot(sub)).toBe(dir);
  });

  it("loadConfig reads JSON and never executes anything", async () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(exampleConfig()));
    expect((await loadConfig(dir)).claimStaleDays).toBe(7);
    writeFileSync(join(dir, CONFIG_FILE), 'export default { throw: new Error("ran") }');
    await expect(loadConfig(dir)).rejects.toThrow(/not valid JSON/);
  });

  it("loadConfigAt reads the file as committed at a ref: null when absent, an error when invalid", async () => {
    const g = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd: dir, encoding: "utf8" },
      ).trim();
    g("init", "-q", "-b", "dev");
    writeFileSync(join(dir, "a.txt"), "a");
    g("add", ".");
    g("commit", "-q", "--no-verify", "-m", "no config");
    const first = g("rev-parse", "HEAD");
    writeFileSync(
      join(dir, CONFIG_FILE),
      JSON.stringify(exampleConfig((c) => (c.branches.integration = "trunk"))),
    );
    g("add", ".");
    g("commit", "-q", "--no-verify", "-m", "config");
    const second = g("rev-parse", "HEAD");
    // The working tree differs; the committed file is what is read.
    writeFileSync(join(dir, CONFIG_FILE), "{}");

    expect(await loadConfigAt(dir, first)).toBeNull();
    expect((await loadConfigAt(dir, second))?.branches.integration).toBe("trunk");
    expect((await loadConfigAt(dir, "dev"))?.branches.integration).toBe("trunk");
    await expect(loadConfigAt(dir, "no-such-ref")).rejects.toThrow(/cannot resolve no-such-ref/);

    writeFileSync(join(dir, CONFIG_FILE), '{ "bogus": 1 }');
    g("commit", "-q", "--no-verify", "-am", "bad config");
    await expect(loadConfigAt(dir, "HEAD")).rejects.toThrow(/at HEAD is not a valid configuration/);
  });
});

describe("upstreamPaths", () => {
  it("without a manifest: the modules, docs/kit and the starter skills, less replaced modules", () => {
    const all = upstreamPaths();
    expect(all).toHaveLength(STARTER_MODULES.length + 1 + STARTER_SKILLS.length);
    expect(upstreamPaths(["journeys"])).not.toContain("tooling/journeys/");
  });

  it("with a manifest: its replace entries, less replaced modules", () => {
    const manifest = {
      version: "0.1.0",
      owned: [
        { path: "tooling/core/", kind: "replace" as const },
        { path: "tooling/journeys/", kind: "replace" as const },
        { path: ".husky/pre-push", kind: "replace" as const },
        { path: ".gitignore", kind: "merge-lines" as const },
      ],
    };
    expect(upstreamPaths([], manifest)).toEqual([
      "tooling/core/",
      "tooling/journeys/",
      ".husky/pre-push",
    ]);
    expect(upstreamPaths(["journeys"], manifest)).toEqual(["tooling/core/", ".husky/pre-push"]);
  });
});

// ─── The schema agrees with the validator ────────────────────────────────────

/**
 * Just enough JSON Schema to evaluate config.schema.json — and it refuses any
 * keyword it does not implement, so the schema cannot grow a constraint this
 * agreement test silently ignores.
 */
function schemaAccepts(schema: Record<string, unknown>, v: unknown): boolean {
  const known = new Set([
    "$schema",
    "title",
    "description",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "pattern",
    "anyOf",
  ]);
  for (const k of Object.keys(schema))
    if (!known.has(k)) throw new Error(`the test evaluator does not implement "${k}"`);
  if (schema.anyOf)
    return (schema.anyOf as Record<string, unknown>[]).some((s) => schemaAccepts(s, v));
  const type = schema.type as string | undefined;
  const isObj = typeof v === "object" && v !== null && !Array.isArray(v);
  if (type === "object" && !isObj) return false;
  if (type === "array" && !Array.isArray(v)) return false;
  if (type === "string" && typeof v !== "string") return false;
  if (type === "boolean" && typeof v !== "boolean") return false;
  if (type === "null" && v !== null) return false;
  if ((type === "number" || type === "integer") && (typeof v !== "number" || !Number.isFinite(v)))
    return false;
  if (type === "integer" && !Number.isInteger(v)) return false;
  if (schema.enum && !(schema.enum as unknown[]).includes(v)) return false;
  if (typeof v === "number") {
    if (schema.minimum !== undefined && v < (schema.minimum as number)) return false;
    if (schema.maximum !== undefined && v > (schema.maximum as number)) return false;
  }
  if (typeof v === "string") {
    if (schema.minLength !== undefined && v.length < (schema.minLength as number)) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string, "u").test(v))
      return false;
  }
  if (Array.isArray(v) && schema.items)
    return v.every((x) => schemaAccepts(schema.items as Record<string, unknown>, x));
  if (isObj) {
    const o = v as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) return false;
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) {
        if (!schemaAccepts(props[k], x)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (typeof schema.additionalProperties === "object") {
        if (!schemaAccepts(schema.additionalProperties as Record<string, unknown>, x)) return false;
      }
    }
  }
  return true;
}

describe("config.schema.json", () => {
  const committed = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;

  it("is what the validator's shape generates (node tooling/core/src/config-schema.mts --write)", () => {
    expect(committed).toEqual(configSchema());
  });

  const examples: Array<[string, unknown]> = [
    ["the example", exampleConfig()],
    ["the repository's", JSON.parse(readFileSync(join(REPO, CONFIG_FILE), "utf8"))],
    ["an unknown top-level key", edited((c) => (c.extra = true))],
    ["an unknown nested key", edited((c) => ((c.branches as Record<string, unknown>).trunk = "x"))],
    ["a missing section", edited((c) => delete c.ci)],
    ["a string for a number", edited((c) => (c.claimStaleDays = "7"))],
    ["a fractional integer", edited((c) => (c.claimStaleDays = 1.5))],
    ["a zero stale days", edited((c) => (c.claimStaleDays = 0))],
    [
      "a weekday out of range",
      edited((c) => (c.cadence = { progressReportWeekdays: [-1], planSyncDays: 7 })),
    ],
    ["a null cli", edited((c) => (c.accounts = [{ name: "x", cli: null, check: [] }]))],
    ["an empty cli", edited((c) => (c.accounts = [{ name: "x", cli: "", check: [] }]))],
    [
      "a bad applies",
      edited(
        (c) => ((c.ci as { steps: unknown[] }).steps = [{ name: "a", run: "b", applies: "x" }]),
      ),
    ],
    [
      "a string history",
      edited(
        (c) =>
          ((c.ci as { steps: unknown[] }).steps = [
            { name: "a", run: "b", applies: "always", history: "yes" },
          ]),
      ),
    ],
    [
      "a container",
      edited((c) => ((c.ci as Record<string, unknown>).container = { image: "node:24" })),
    ],
    [
      "an unknown engine",
      edited((c) => ((c.ci as Record<string, unknown>).container = { image: "i", engine: "lxc" })),
    ],
    [
      "a container without an image",
      edited((c) => ((c.ci as Record<string, unknown>).container = {})),
    ],
    [
      "a coverage floor",
      edited((c) => (c.coverage = { floors: { a: { lines: 90, branches: 80 } } })),
    ],
    [
      "a coverage floor over 100",
      edited((c) => (c.coverage = { floors: { a: { lines: 190, branches: 80 } } })),
    ],
    [
      "a floor with a typo",
      edited((c) => (c.coverage = { floors: { a: { line: 90, branches: 80 } } })),
    ],
    ["a bad database name", edited((c) => (c.localdb = { databases: [{ name: "a b" }] }))],
    ["a replaced module", edited((c) => (c.modules = { replaced: ["seed"] }))],
    ["an unknown replaced module", edited((c) => (c.modules = { replaced: ["nope"] }))],
    ["configVersion 0", edited((c) => (c.configVersion = 0))],
  ];

  it.each(examples)("agrees with the validator on %s", (_name, value) => {
    expect(schemaAccepts(committed, value)).toBe(problems(value).length === 0);
  });

  it("the examples include both verdicts", () => {
    const verdicts = new Set(examples.map(([, v]) => problems(v).length === 0));
    expect(verdicts).toEqual(new Set([true, false]));
  });
});
