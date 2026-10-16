import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMMON,
  assertPersona,
  assertTitle,
  journeyFolder,
  loadRegistryFile,
  personaLabel,
  slug,
  validateRegistry,
} from "./registry.mts";
import type { Registry } from "./registry.mts";

const registry: Registry = {
  journeys: [{ id: "J4", title: "Signing In", personas: ["organizer"] }],
  personas: { organizer: { label: "An organizer" }, attendee: { label: "An attendee" } },
};

describe("the journey registry", () => {
  it("names a folder the way every reader does, keeping the id's case", () => {
    expect(slug("Owner Payout & Statement")).toBe("owner-payout-statement");
    expect(journeyFolder("J4", "Signing In")).toBe("J4-signing-in");
  });

  it("refuses an unknown id and a second spelling of a title", () => {
    expect(() => assertTitle(registry, "J9", "x")).toThrow(/JOURNEY-020/);
    expect(() => assertTitle(registry, "J4", "Signing in")).toThrow(/"Signing In" in the registry/);
    expect(assertTitle(registry, "J4", "Signing In").id).toBe("J4");
  });

  it("allows `common` for any journey, and only declared personas otherwise", () => {
    const j = registry.journeys[0]!;
    expect(() => assertPersona(registry, j, COMMON)).not.toThrow();
    expect(() => assertPersona(registry, j, "organizer")).not.toThrow();
    expect(() => assertPersona(registry, j, "attendee")).toThrow(/JOURNEY-023/);
    expect(() => assertPersona(registry, j, "nobody")).toThrow(/JOURNEY-022/);
    expect(personaLabel(registry, "organizer")).toBe("An organizer");
  });

  it("refuses a registry that would fail somewhere else later", () => {
    const bad = (r: Partial<Registry>) => () =>
      validateRegistry({ journeys: [], personas: {}, ...r });
    expect(
      bad({
        journeys: [
          { id: "J1", title: "a", personas: [] },
          { id: "J1", title: "b", personas: [] },
        ],
      }),
    ).toThrow(/twice/);
    expect(bad({ journeys: [{ id: "x", title: "a", personas: [] }] })).toThrow(
      /prefix and a number/,
    );
    expect(bad({ journeys: [{ id: "J1", title: "a", personas: ["ghost"] }] })).toThrow(/ghost/);
    expect(bad({ personas: { common: { label: "x" } } })).toThrow(/reserved/);
  });

  it("loads a registry module by either export, and refuses one with neither", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "journeys-registry-")));
    writeFileSync(
      join(root, "named.mts"),
      `export const registry = ${JSON.stringify(registry)};\n`,
    );
    writeFileSync(join(root, "none.mts"), "export const x = 1;\n");
    expect((await loadRegistryFile("named.mts", root)).journeys).toHaveLength(1);
    await expect(loadRegistryFile("none.mts", root)).rejects.toThrow(/JOURNEY-025/);
  });
});
