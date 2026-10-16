/**
 * The two merges `pnpm sdlc:update` applies to files a project and the starter
 * share (tooling/core/src/manifest.mts). Both are pure, idempotent, and never
 * remove anything the project added: running one twice changes nothing, and a
 * line or a value present before is present after.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObj = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && equal(a[k], b[k]));
  }
  return false;
}

/**
 * The key an array element is matched by, when it has one. A hook group is the
 * same group when its `matcher` is; a hook is the same hook when its `command`
 * is. Matched elements merge; anything else is matched by its whole value.
 */
const IDENTITY_KEYS = ["matcher", "command"];

function identity(v: Json): string | null {
  if (!isObj(v)) return null;
  for (const k of IDENTITY_KEYS) if (typeof v[k] === "string") return `${k}\u0000${v[k] as string}`;
  return null;
}

/**
 * The project's value with the starter's merged in. Objects merge key by key;
 * arrays are a union (by identity key, else by value), the project's elements
 * first and in its order; for a scalar, or a type that differs, the project's
 * value stands. A key or element the starter dropped is kept — removal is the
 * project's decision, which MIGRATIONS.md asks it to make.
 */
export function unionJson(project: Json | undefined, starter: Json): Json {
  if (project === undefined) return clone(starter);
  if (isObj(project) && isObj(starter)) {
    const out: Record<string, Json> = { ...project };
    for (const [k, v] of Object.entries(starter)) out[k] = unionJson(project[k], v);
    return out;
  }
  if (Array.isArray(project) && Array.isArray(starter)) {
    const out = [...project];
    for (const item of starter) {
      const id = identity(item);
      const at = id === null ? -1 : out.findIndex((x) => identity(x) === id);
      if (at >= 0) out[at] = unionJson(out[at], item);
      else if (!out.some((x) => equal(x, item))) out.push(clone(item));
    }
    return out;
  }
  return project;
}

/**
 * Only the named keys are the starter's, and those take the starter's value:
 * `{ scripts: ["ci:local"] }` sets `scripts["ci:local"]` and touches nothing
 * else. A listed key the starter no longer has is left alone.
 */
export function ownedKeysJson(
  project: Json | undefined,
  starter: Json,
  keys: Record<string, string[]>,
): Json {
  const out: Record<string, Json> = isObj(project) ? clone(project) : {};
  if (!isObj(starter)) return out;
  for (const [section, names] of Object.entries(keys)) {
    const from = starter[section];
    if (!isObj(from)) continue;
    for (const name of names) {
      if (from[name] === undefined) continue;
      const into = isObj(out[section]) ? out[section] : (out[section] = {});
      into[name] = clone(from[name]);
    }
  }
  return out;
}

/** merge-json on text. A project file that is not JSON is an error, not an overwrite. */
export function mergeJsonText(
  project: string | null,
  starter: string,
  keys?: Record<string, string[]>,
): string {
  const s = JSON.parse(starter) as Json;
  let p: Json | undefined;
  if (project !== null) {
    try {
      p = JSON.parse(project) as Json;
    } catch (e) {
      throw new Error(`the project's file is not valid JSON: ${(e as Error).message}`);
    }
  }
  const merged = keys ? ownedKeysJson(p, s, keys) : unionJson(p, s);
  // Unchanged content keeps the project's formatting byte for byte.
  if (project !== null && p !== undefined && equal(p, merged)) return project;
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Every non-blank line of the starter's file that the project lacks is added;
 * nothing is removed or reordered. A missing line goes after the nearest line
 * above it in the starter's file that the project has — so an entry added to a
 * YAML list lands in that list, not at the end of the file — else at the end.
 */
export function mergeLines(project: string | null, starter: string): string {
  const split = (t: string) => (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
  const out = project === null || project === "" ? [] : split(project);
  const have = new Set(out.map((l) => l.trimEnd()));
  const theirs = split(starter);
  let added = false;
  theirs.forEach((line, i) => {
    const key = line.trimEnd();
    if (key.trim() === "" || have.has(key)) return;
    let at = out.length;
    for (let j = i - 1; j >= 0; j--) {
      const above = (theirs[j] as string).trimEnd();
      if (above.trim() === "") continue;
      const k = out.findIndex((l) => l.trimEnd() === above);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, key);
    have.add(key);
    added = true;
  });
  if (!added && project !== null) return project;
  return out.length ? `${out.join("\n")}\n` : "";
}
