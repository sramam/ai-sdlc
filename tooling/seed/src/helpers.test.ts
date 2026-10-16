import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRandom,
  days,
  fromCaptured,
  int,
  isSeedId,
  parseIsoDate,
  pick,
  stableId,
  today,
} from "./helpers.mts";

afterEach(() => vi.unstubAllEnvs());

const draw = (seed: string, n = 20) => {
  const r = createRandom(seed);
  return Array.from({ length: n }, () => r());
};

describe("the PRNG is deterministic", () => {
  it("same seed, same sequence", () => expect(draw("ai-sdlc")).toEqual(draw("ai-sdlc")));
  it("different seed, different sequence", () =>
    expect(draw("ai-sdlc")).not.toEqual(draw("ai-sdlc2")));
  it("stays in [0, 1)", () => {
    for (const x of draw("range", 5000)) expect(x >= 0 && x < 1).toBe(true);
  });
  it("reads SEED_RANDOM when no seed is given", () => {
    vi.stubEnv("SEED_RANDOM", "from-env");
    const r = createRandom();
    expect([r(), r()]).toEqual(draw("from-env", 2));
  });
  it("is pinned: the first value never changes without somebody meaning it", () => {
    // Changing these means every seeded screenshot and assertion moves: do it on purpose.
    expect(createRandom("ai-sdlc")()).toBe(0.21202272945083678);
    expect(stableId("person", 1)).toBe("5eed2dcc-e068-8521-ba80-660411bcb903");
  });
});

describe("pick and int", () => {
  it("int covers both ends and nothing outside", () => {
    const r = createRandom("int");
    const seen = new Set(Array.from({ length: 2000 }, () => int(r, 1, 6)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("same seed, same picks", () => {
    const names = ["ada", "bo", "cy", "di"];
    const a = createRandom("p");
    const b = createRandom("p");
    expect(Array.from({ length: 10 }, () => pick(a, names))).toEqual(
      Array.from({ length: 10 }, () => pick(b, names)),
    );
  });
  it("refuses an empty list and a reversed range", () => {
    expect(() => pick(createRandom("x"), [])).toThrow(/empty/);
    expect(() => int(createRandom("x"), 5, 1)).toThrow();
  });
});

describe("fromCaptured wraps", () => {
  it("indexes and wraps, negative too", () => {
    const list = ["a", "b", "c"];
    expect([0, 1, 2, 3, 4, -1].map((i) => fromCaptured(list, i))).toEqual([
      "a",
      "b",
      "c",
      "a",
      "b",
      "c",
    ]);
    expect(() => fromCaptured([], 0)).toThrow(/empty/);
  });
});

describe("dates are relative to SEED_TODAY", () => {
  it("days(n) counts from the pinned today", () => {
    vi.stubEnv("SEED_TODAY", "2026-02-27");
    expect(days(0).iso).toBe("2026-02-27");
    expect(days(2).iso).toBe("2026-03-01");
    expect(days(-60).iso).toBe("2025-12-29");
    expect(days(1).date).toBeInstanceOf(Date);
  });
  it("refuses a SEED_TODAY that is not a real date", () => {
    vi.stubEnv("SEED_TODAY", "2026-02-30");
    expect(() => today()).toThrow(/YYYY-MM-DD/);
    expect(parseIsoDate("2026-13-01")).toBeNull();
  });
  it("defaults to this machine's calendar date", () => {
    vi.stubEnv("SEED_TODAY", undefined as unknown as string);
    const now = new Date();
    expect(today().getTime()).toBe(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  });
});

describe("stable ids", () => {
  it("are deterministic, UUID-shaped and recognised", () => {
    const id = stableId("person", 7);
    expect(id).toBe(stableId("person", 7));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isSeedId(id)).toBe(true);
  });
  it("differ by namespace and by n, without collisions in a realistic run", () => {
    expect(stableId("person", 7)).not.toBe(stableId("lease", 7));
    const ids = new Set(Array.from({ length: 10_000 }, (_, i) => stableId("row", i)));
    expect(ids.size).toBe(10_000);
  });
  it("a random v4 uuid is not a seed id", () => {
    expect(isSeedId(crypto.randomUUID())).toBe(false);
  });
});
