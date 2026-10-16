// The manifest pattern check: every capability is describable to OpenAPI and MCP, its
// name is unique, and no input can carry authority.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTHORITY_KEYS, manifest } from "./manifest";

describe("manifest", () => {
  it("names are unique and <entity>.<verb>", () => {
    const names = manifest.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/);
  });

  it.each(manifest.map((c) => [c.name, c] as const))(
    "%s: input and output have JSON Schemas",
    (_n, c) => {
      // A BigInt or Date in a schema throws here, and would be invisible to OpenAPI and MCP.
      expect(() => z.toJSONSchema(c.input)).not.toThrow();
      expect(() => z.toJSONSchema(c.output)).not.toThrow();
    },
  );

  it.each(manifest.map((c) => [c.name, c] as const))(
    "%s: no input key carries authority",
    (_n, c) => {
      const json = JSON.stringify(z.toJSONSchema(c.input));
      for (const k of AUTHORITY_KEYS) expect(json).not.toContain(`"${k}"`);
    },
  );

  it.each(manifest.map((c) => [c.name, c] as const))(
    "%s: a write authorizes one resource",
    (_n, c) => {
      if (c.effect === "write") expect(c.access.kind).toBe("check");
    },
  );
});
