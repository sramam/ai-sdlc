// @ts-check
/**
 * The merges `ai-sdlc add` and `update` apply to files a project and its items
 * share: package.json, sdlc.config.json, .gitignore and pnpm-workspace.yaml.
 * All are pure, idempotent, and never remove or overwrite anything the project
 * has: running one twice changes nothing, and a value present before is
 * present after. Where an item wants a different value, the project's stands
 * and the difference is reported.
 */

/** JSON as parsed. `any`, because a JSDoc type alias cannot refer to itself. @typedef {any} Json */

/** @param {unknown} v @returns {v is Record<string, Json>} */
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @template T @param {T} v @returns {T} */
const clone = (v) => JSON.parse(JSON.stringify(v));

/** @param {unknown} a @param {unknown} b @returns {boolean} */
export function equal(a, b) {
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
 * The key an array element is matched by, when it has one: a hook group by its
 * `matcher`, a hook by its `command`, a CI step or a database by its `name`.
 * Matched elements merge; anything else is matched by its whole value.
 */
const IDENTITY_KEYS = ["matcher", "command", "name"];

/** @param {Json} v @returns {string | null} */
function identity(v) {
  if (!isObj(v)) return null;
  for (const k of IDENTITY_KEYS) {
    const id = v[k];
    if (typeof id === "string") return `${k}\u0000${id}`;
  }
  return null;
}

/**
 * The project's value with the item's merged in. Objects merge key by key;
 * arrays are a union (by identity key, else by value), the project's elements
 * first and in its order; for a scalar, or a type that differs, the project's
 * value stands.
 * @param {Json | undefined} project
 * @param {Json} item
 * @returns {Json}
 */
export function unionJson(project, item) {
  if (project === undefined) return clone(item);
  if (isObj(project) && isObj(item)) {
    /** @type {Record<string, Json>} */
    const out = { ...project };
    for (const [k, v] of Object.entries(item)) out[k] = unionJson(project[k], v);
    return out;
  }
  if (Array.isArray(project) && Array.isArray(item)) {
    const out = [...project];
    for (const el of item) {
      const id = identity(el);
      const at = id === null ? -1 : out.findIndex((x) => identity(x) === id);
      if (at >= 0) out[at] = unionJson(out[at], el);
      else if (!out.some((x) => equal(x, el))) out.push(clone(el));
    }
    return out;
  }
  return project;
}

/**
 * Where `have` does not contain `want`: the paths at which the project kept a
 * value of its own. Arrays match elements by identity key, else by value.
 * @param {Json | undefined} have
 * @param {Json} want
 * @param {string} [at]
 * @returns {string[]}
 */
export function differences(have, want, at = "") {
  if (isObj(want)) {
    if (!isObj(have)) return [at || "(root)"];
    return Object.entries(want).flatMap(([k, v]) => differences(have[k], v, at ? `${at}.${k}` : k));
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(have)) return [at || "(root)"];
    return want.flatMap((el, i) => {
      const id = identity(el);
      const label = id === null ? String(i) : (id.split("\u0000")[1] ?? String(i));
      const match =
        id === null ? have.find((x) => equal(x, el)) : have.find((x) => identity(x) === id);
      if (match === undefined) return [`${at}[${label}]`];
      return id === null ? [] : differences(match, el, `${at}[${label}]`);
    });
  }
  return equal(have, want) ? [] : [at || "(root)"];
}

/**
 * @typedef {{
 *   scripts?: Record<string, string>,
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>,
 * }} PackageFragment
 */
export const PACKAGE_SECTIONS = /** @type {const} */ ([
  "scripts",
  "dependencies",
  "devDependencies",
]);

/**
 * An item's scripts and dependencies into a package.json object. A key the
 * project lacks is added; a key it holds with another value is kept and
 * reported.
 * @param {Record<string, any>} pkg
 * @param {PackageFragment} fragment
 * @returns {{ pkg: Record<string, any>, added: string[], kept: string[] }}
 */
export function mergePackage(pkg, fragment) {
  const out = clone(pkg);
  /** @type {string[]} */ const added = [];
  /** @type {string[]} */ const kept = [];
  for (const section of PACKAGE_SECTIONS) {
    const want = fragment[section];
    if (!want) continue;
    if (!isObj(out[section])) out[section] = {};
    const into = out[section];
    for (const [name, value] of Object.entries(want)) {
      if (into[name] === undefined) {
        into[name] = value;
        added.push(`${section}.${name}`);
      } else if (into[name] !== value)
        kept.push(`${section}.${name}: kept "${into[name]}", the item has "${value}"`);
    }
  }
  return { pkg: out, added, kept };
}

/**
 * An item's config fragment into sdlc.config.json: a union, then the paths at
 * which the project's own value stood instead of the item's.
 * @param {Json} config
 * @param {Json} fragment
 * @returns {{ config: Json, kept: string[] }}
 */
export function mergeConfig(config, fragment) {
  const merged = unionJson(config, fragment);
  return { config: merged, kept: differences(merged, fragment) };
}

/**
 * Every non-blank line of `item` that the project lacks is added; nothing is
 * removed or reordered. A missing line goes after the nearest line above it in
 * the item's text that the project has, else at the end.
 * @param {string | null} project
 * @param {string} item
 * @returns {string}
 */
export function mergeLines(project, item) {
  /** @param {string} t */
  const split = (t) => (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
  const out = project === null || project === "" ? [] : split(project);
  const have = new Set(out.map((l) => l.trimEnd()));
  const theirs = split(item);
  let added = false;
  theirs.forEach((line, i) => {
    const key = line.trimEnd();
    if (key.trim() === "" || have.has(key)) return;
    let at = out.length;
    for (let j = i - 1; j >= 0; j--) {
      const above = (theirs[j] ?? "").trimEnd();
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

/** @param {string} s */
const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");

/**
 * Adds names to `onlyBuiltDependencies` in pnpm-workspace.yaml, in either form
 * pnpm writes (`[]` inline, or a block list), keeping every other line. A file
 * with no such key gets one at the end.
 * @param {string} text
 * @param {string[]} names
 * @returns {string}
 */
export function addBuiltDependencies(text, names) {
  if (!names.length) return text;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^onlyBuiltDependencies:/.test(l));
  /** @type {string[]} */
  const have = [];
  let end = at + 1;
  if (at >= 0) {
    const inline = /^onlyBuiltDependencies:\s*\[(.*)\]\s*$/.exec(lines[at] ?? "");
    if (inline) have.push(...(inline[1] ?? "").split(",").map(unquote).filter(Boolean));
    else
      while (end < lines.length && /^\s+-\s/.test(lines[end] ?? "")) {
        have.push(unquote((lines[end] ?? "").replace(/^\s+-\s+/, "")));
        end++;
      }
  }
  const missing = names.filter((n) => !have.includes(n));
  if (!missing.length && at >= 0) return text;
  const block = ["onlyBuiltDependencies:", ...[...have, ...missing].map((n) => `  - ${n}`)];
  if (at < 0) {
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    return `${body}\n\n${block.join("\n")}\n`;
  }
  lines.splice(at, end - at, ...block);
  return lines.join("\n");
}
