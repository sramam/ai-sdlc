/**
 * What a seeder imports to be deterministic. Dependency-free, and free of
 * `node:` imports too, so the same file works in a Worker, a browser test or
 * Node.
 *
 *   import { createRandom, pick, int, days, stableId, fromCaptured } from "@ai-sdlc/seed/helpers";
 *
 * `pnpm seed` sets SEED_RANDOM and SEED_TODAY; every helper reads them, so a
 * seeder that uses these and nothing else produces the same rows on every run
 * (docs/kit/data-model.md § Seed and demo data).
 */

export const DEFAULT_SEED_RANDOM = "ai-sdlc";

/** A uniform number in [0, 1). */
export type Random = () => number;

function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}

/** A 32-bit hash of a string under a seed (MurmurHash3's mixing). */
export function hash32(text: string, seed = 0): number {
  let h = seed ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * mulberry32, seeded from a string. Default seed: SEED_RANDOM, else "ai-sdlc".
 * Make one per concern (`createRandom("people")`, `createRandom("leases")`) so
 * adding a draw to one does not shift every value in the other.
 */
export function createRandom(seed: string = env("SEED_RANDOM") ?? DEFAULT_SEED_RANDOM): Random {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [min, max], both inclusive. */
export function int(random: Random, min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min)
    throw new Error(`int: need integers min <= max, got ${min}, ${max}`);
  return min + Math.floor(random() * (max - min + 1));
}

/** One element of a non-empty list. */
export function pick<T>(random: Random, list: readonly T[]): T {
  if (!list.length) throw new Error("pick: the list is empty");
  return list[Math.floor(random() * list.length)] as T;
}

/**
 * Captured real values (addresses, names that pass validation), indexed and
 * wrapped, so a seed larger than the capture repeats rather than throws — and
 * index N is always the same value, which keeps a screenshot stable.
 */
export function fromCaptured<T>(list: readonly T[], i: number): T {
  if (!list.length) throw new Error("fromCaptured: the captured list is empty");
  if (!Number.isInteger(i)) throw new Error(`fromCaptured: index must be an integer, got ${i}`);
  return list[((i % list.length) + list.length) % list.length] as T;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse YYYY-MM-DD to UTC midnight, or null when it is not a real date. */
export function parseIsoDate(text: string): Date | null {
  const m = ISO_DATE.exec(text);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === text ? d : null;
}

/** "Today" for the seed: SEED_TODAY, else this machine's calendar date — as UTC midnight either way. */
export function today(): Date {
  const pinned = env("SEED_TODAY");
  if (pinned !== undefined) {
    const d = parseIsoDate(pinned);
    if (!d) throw new Error(`SEED_TODAY must be YYYY-MM-DD, got ${JSON.stringify(pinned)}`);
    return d;
  }
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * A date `n` days from the seed's today (negative for the past). Seeds use
 * these, never literal dates, so "expires in 45 days" stays true next month.
 */
export function days(n: number, from: Date = today()): { date: Date; iso: string } {
  const date = new Date(from.getTime() + n * 86_400_000);
  return { date, iso: date.toISOString().slice(0, 10) };
}

/** The marker every seed id starts with — what `isSeedId` recognises. */
export const SEED_ID_PREFIX = "5eed";

/**
 * A deterministic, UUID-shaped id: the same (namespace, n) always gives the
 * same id. Version 8 (RFC 9562 "custom"), so a `uuid` column accepts it, and it
 * starts with `5eed` so seed-owned rows can be found and deleted.
 */
export function stableId(namespace: string, n: number | string): string {
  const key = `${namespace}\0${n}`;
  const hex = [1, 2, 3, 4].map((s) => hash32(key, s).toString(16).padStart(8, "0")).join("");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const body = `${SEED_ID_PREFIX}${hex.slice(4, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`;
}

const SEED_ID = /^5eed[0-9a-f]{4}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for an id `stableId` could have produced. */
export function isSeedId(id: string): boolean {
  return SEED_ID.test(id);
}
