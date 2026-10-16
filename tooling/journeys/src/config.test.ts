import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  DEFAULT_JOURNEYS_CONFIG,
  defineJourneysConfig,
  loadJourneysConfig,
  resolveJourneysConfig,
} from "./config.mts";
import { CONFIG_FILE as SDLC_CONFIG } from "../../core/src/config.mts";
import { DATE_SHAPES, DECLARED_VOLATILE } from "./mask/dom.mts";

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "journeys-config-")));
  writeFileSync(join(dir, SDLC_CONFIG), "{}\n");
  return dir;
};

describe("the journeys config", () => {
  it("defaults to door_nexa's values", () => {
    const c = resolveJourneysConfig();
    expect(c.evidenceRoot).toBe("docs/journeys");
    expect(c.scratchRoot).toBe("test-results");
    expect(c.ports).toEqual({
      appBase: 3100,
      dbBase: 5500,
      slots: 128,
      marker: "pnpm-workspace.yaml",
    });
    expect(c.declaredVolatile).toEqual([...DECLARED_VOLATILE]);
    expect(c.dateShapes).toEqual([...DATE_SHAPES]);
  });

  it("overrides field by field, and ports key by key", () => {
    const c = resolveJourneysConfig({ evidenceRoot: "e2e/evidence", ports: { appBase: 4000 } });
    expect(c.evidenceRoot).toBe("e2e/evidence");
    expect(c.ports).toEqual({ ...DEFAULT_JOURNEYS_CONFIG.ports, appBase: 4000 });
  });

  it("replaces a list rather than appending to it", () => {
    const only = [{ selector: "[data-clock]", why: "ticks once a minute" }];
    expect(resolveJourneysConfig({ declaredVolatile: only }).declaredVolatile).toEqual(only);
  });

  it("refuses a date shape that would throw inside a browser mid-recording", () => {
    expect(() => resolveJourneysConfig({ dateShapes: ["(unclosed"] })).toThrow(
      /JOURNEYS-CONFIG-001.*dateShapes/,
    );
  });

  it("refuses a band that runs off the end of the port range", () => {
    expect(() => resolveJourneysConfig({ ports: { dbBase: 65500, slots: 128 } })).toThrow(
      /JOURNEYS-CONFIG-001/,
    );
  });

  it("refuses a declared selector with no reason", () => {
    expect(() =>
      resolveJourneysConfig({ declaredVolatile: [{ selector: "[x]", why: "" }] }),
    ).toThrow(/needs a selector and a why/);
  });

  it("is the identity at definition", () => {
    const input = { scratchRoot: "tmp" };
    expect(defineJourneysConfig(input)).toBe(input);
  });
});

describe("loadJourneysConfig", () => {
  it("answers the defaults when there is no file", async () => {
    expect(await loadJourneysConfig(repo())).toEqual(resolveJourneysConfig());
  });

  it("reads journeys.config.mts at the root, from a subdirectory", async () => {
    const dir = repo();
    writeFileSync(join(dir, CONFIG_FILE), 'export default { evidenceRoot: "evidence" };\n');
    const sub = join(dir, "apps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sub);
    expect((await loadJourneysConfig(sub)).evidenceRoot).toBe("evidence");
  });

  it("refuses a file with no default export", async () => {
    const dir = repo();
    writeFileSync(join(dir, CONFIG_FILE), "export const journeys = {};\n");
    await expect(loadJourneysConfig(dir)).rejects.toThrow(/JOURNEYS-CONFIG-002/);
  });
});

describe("the recorder's half of the config", () => {
  it("defaults to TanStack routes, an empty registry, aria-busy and the reports kept by the sweep", () => {
    const c = resolveJourneysConfig();
    expect(c.routes).toEqual({ kind: "tanstack", dir: "src/routes" });
    expect(c.registry).toEqual({ journeys: [], personas: {} });
    expect(c.settle.busySelector).toBe('[aria-busy="true"]');
    expect(c.settle.selectors).toEqual([]);
    expect(c.reportRoot).toBe("test-results/journey-reports");
    expect(c.scratchKeep).toContain("journey-reports");
  });

  it("merges settle key by key, so a project naming selectors keeps the busy wait", () => {
    const c = resolveJourneysConfig({ settle: { hide: ["nextjs-portal"] } });
    expect(c.settle.hide).toEqual(["nextjs-portal"]);
    expect(c.settle.busySelector).toBe('[aria-busy="true"]');
  });

  it("refuses a settle text pattern that does not compile, and a registry that does not hold", () => {
    expect(() =>
      resolveJourneysConfig({ settle: { selectors: [{ selector: "#x", until: { text: "(" } }] } }),
    ).toThrow(/until\.text does not compile/);
    expect(() =>
      resolveJourneysConfig({
        registry: { journeys: [{ id: "J1", title: "a", personas: ["ghost"] }], personas: {} },
      }),
    ).toThrow(/JOURNEY-024/);
  });

  it("reads the registry from `registryFile` when one is named", async () => {
    const dir = repo();
    writeFileSync(
      join(dir, "journeys.registry.mts"),
      'export const registry = { journeys: [{ id: "J1", title: "One", personas: [] }], personas: {} };\n',
    );
    writeFileSync(
      join(dir, CONFIG_FILE),
      'export default { registryFile: "journeys.registry.mts" };\n',
    );
    expect((await loadJourneysConfig(dir)).registry.journeys.map((j) => j.id)).toEqual(["J1"]);
  });
});
