import { describe, expect, it } from "vitest";
import { memoryTracer } from "./memory";
import { inSpan } from "./span";

const refusal = { ok: false as const, code: "INVALID", detail: "no" };

describe("inSpan", () => {
  it("records the outcome from the result's shape", async () => {
    const t = memoryTracer();
    await inSpan(t, "a", { "app.capability": "a" }, async () => ({ ok: true }));
    await inSpan(t, "a", { "app.capability": "a" }, async () => refusal);
    expect(t.spans.map((s) => s.attributes["app.outcome"])).toEqual(["ok", "refused"]);
    expect(t.spans[1]?.attributes["app.refusal.code"]).toBe("INVALID");
  });

  it("parents by async context, so concurrent children nest correctly", async () => {
    const t = memoryTracer();
    await inSpan(t, "outer", {}, () =>
      Promise.all([inSpan(t, "x", {}, async () => 1), inSpan(t, "y", {}, async () => 2)]),
    );
    expect(t.spans.map((s) => [s.name, s.parent])).toEqual([
      ["outer", null],
      ["x", "outer"],
      ["y", "outer"],
    ]);
  });

  it("refuses an undeclared attribute under test (TEL-001)", async () => {
    const t = memoryTracer();
    const leak = { "user.email": "a@example.test" } as Record<string, string>;
    await expect(inSpan(t, "x", leak, async () => 1)).rejects.toThrow(/TEL-001.*user\.email/);
  });

  it("marks a throw as error and records it", async () => {
    const t = memoryTracer();
    const boom = async () => {
      throw new Error("nope");
    };
    await expect(inSpan(t, "boom", {}, boom)).rejects.toThrow("nope");
    expect(t.spans[0]).toMatchObject({
      attributes: { "app.outcome": "error" },
      error: "Error: nope",
    });
  });
});
