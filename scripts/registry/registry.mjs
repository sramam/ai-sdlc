// @ts-check
/**
 * `registry.json`: what can be installed into a project, and from which files.
 * Read from a source directory (a checkout or fetch of github.com/sramam/ai-sdlc
 * at some ref) by every CLI command, and by the pattern check.
 *
 * One root file rather than one per item, because an item is not a directory:
 * `base` gathers root configuration, ten skills, the kit and five modules from
 * all over the tree. In one file, "every file belongs to exactly one item" is a
 * single pass, a change to what an item ships is one diff, and nothing that
 * exists only for the registry is ever copied into a project.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const REGISTRY_FILE = "registry.json";

/**
 * @typedef {{ from: string, to?: string, except?: string[], seed?: boolean }} FileRule
 * @typedef {{ from?: string } & import("./merge.mjs").PackageFragment} ItemPackage
 * @typedef {{
 *   kind: "base" | "module" | "skill" | "recipe",
 *   description: string,
 *   files: (string | FileRule)[],
 *   requires?: string[],
 *   requiresBecause?: Record<string, string>,
 *   conflicts?: string[],
 *   package?: ItemPackage,
 *   packageJson?: string,
 *   config?: { from?: string } & Record<string, unknown>,
 *   gitignore?: string[],
 *   onlyBuiltDependencies?: string[],
 *   external?: Record<string, string>,
 *   notes?: string,
 *   check?: { dir?: string, before?: string[], test?: string, vitest?: string[], via?: string, skip?: string, with?: string[] },
 * }} Item
 * @typedef {{
 *   registryVersion: number,
 *   repo: string,
 *   exclude: Record<string, string>,
 *   registryOnly: { scripts: Record<string, string>, omit?: Record<string, string> },
 *   items: Record<string, Item>,
 * }} Registry
 * @typedef {{ from: string, to: string, seed: boolean }} Planned
 */

/** @param {string} msg */
const fail = (msg) => {
  throw new Error(`${REGISTRY_FILE}: ${msg}`);
};

/**
 * @param {string} dir
 * @returns {Registry}
 */
export function loadRegistry(dir) {
  const path = join(dir, REGISTRY_FILE);
  if (!existsSync(path)) fail(`not found in ${dir} — is this an ai-sdlc source?`);
  /** @type {Registry} */
  let reg;
  try {
    reg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(`not valid JSON: ${/** @type {Error} */ (e).message}`);
  }
  if (reg.registryVersion !== 1)
    fail(`registryVersion ${reg.registryVersion} is not one this CLI reads (1)`);
  if (!reg.items || typeof reg.items !== "object") fail("no items");
  if (!reg.items.base) fail("no base item");
  for (const [name, item] of Object.entries(reg.items)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      fail(`item name "${name}" must be lowercase words joined by -`);
    if (!["base", "module", "skill", "recipe"].includes(item.kind))
      fail(`${name}.kind must be base, module, skill or recipe`);
    if (!Array.isArray(item.files) || !item.files.length) fail(`${name}.files is empty`);
    for (const dep of [...(item.requires ?? []), ...(item.conflicts ?? [])])
      if (!reg.items[dep]) fail(`${name} names "${dep}", which is not an item`);
    for (const rule of item.files) {
      const r = rule === null || typeof rule !== "object" ? { from: rule } : rule;
      if (
        typeof r.from !== "string" ||
        !r.from ||
        r.from.startsWith("/") ||
        r.from.split("/").includes("..")
      )
        fail(
          `${name}: a file's from must be a relative path inside the source (${JSON.stringify(rule)})`,
        );
      const to = r.to ?? r.from;
      if (to.startsWith("/") || to.split("/").includes(".."))
        fail(`${name}: "${to}" leaves the project`);
      if (r.from.endsWith("/") !== to.endsWith("/"))
        fail(`${name}: "${r.from}" → "${to}" mixes a directory and a file`);
    }
  }
  return reg;
}

/**
 * Every file of a source tree, as relative paths with `/`. A git checkout
 * answers with its tracked and untracked-but-not-ignored files (so a working
 * tree under development is read as it stands); anything else is walked,
 * skipping `node_modules` and `.git`.
 * @param {string} dir
 * @returns {string[]}
 */
export function listSourceFiles(dir) {
  if (existsSync(join(dir, ".git"))) {
    const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status === 0)
      return [...new Set(r.stdout.split("\0").filter(Boolean))]
        .filter((p) => existsSync(join(dir, p)) && statSync(join(dir, p)).isFile())
        .sort();
  }
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** @param {string | FileRule} rule @returns {Required<Pick<FileRule, "from" | "to">> & FileRule} */
export function normRule(rule) {
  const r = typeof rule === "string" ? { from: rule } : rule;
  return { ...r, to: r.to ?? r.from };
}

/**
 * The files an item copies, source → target, from the list of source files.
 * A rule that matches nothing is an error: it names a file that is gone.
 * @param {Item} item
 * @param {string[]} sourceFiles
 * @param {string} [name]
 * @returns {Planned[]}
 */
export function expandItem(item, sourceFiles, name = "item") {
  /** @type {Planned[]} */
  const out = [];
  for (const rule of item.files.map(normRule)) {
    const except = rule.except ?? [];
    const skip = (/** @type {string} */ p) =>
      except.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
    const hits = rule.from.endsWith("/")
      ? sourceFiles.filter((p) => p.startsWith(rule.from) && !skip(p))
      : sourceFiles.filter((p) => p === rule.from);
    if (!hits.length) throw new Error(`${name}: "${rule.from}" matches no file in the source`);
    for (const from of hits)
      out.push({ from, to: rule.to + from.slice(rule.from.length), seed: rule.seed === true });
  }
  return out;
}

/**
 * The files an item reads but does not copy: its package and config fragments.
 * @param {Item} item
 * @returns {string[]}
 */
export function fragmentFiles(item) {
  return [item.package?.from, item.config?.from].filter((p) => typeof p === "string");
}

/**
 * The package.json an item's package fragment is merged into.
 * @param {Item} item
 */
export const packageJsonOf = (item) => item.packageJson ?? "package.json";

/**
 * The item's package fragment, with a `from` file's dependencies read in.
 * @param {Item} item
 * @param {string} sourceDir
 * @returns {import("./merge.mjs").PackageFragment}
 */
export function packageFragment(item, sourceDir) {
  const p = item.package ?? {};
  /** @type {import("./merge.mjs").PackageFragment} */
  const out = {};
  if (p.from) {
    const file = JSON.parse(readFileSync(join(sourceDir, p.from), "utf8"));
    if (file.dependencies) out.dependencies = { ...file.dependencies };
    if (file.devDependencies) out.devDependencies = { ...file.devDependencies };
  }
  for (const section of /** @type {const} */ (["scripts", "dependencies", "devDependencies"]))
    if (p[section]) out[section] = { ...(out[section] ?? {}), ...p[section] };
  return out;
}

/**
 * The item's sdlc.config.json fragment, with a `from` file read in.
 * @param {Item} item
 * @param {string} sourceDir
 * @returns {Record<string, any> | null}
 */
export function configFragment(item, sourceDir) {
  if (!item.config) return null;
  const { from, ...inline } = item.config;
  const base = from ? JSON.parse(readFileSync(join(sourceDir, from), "utf8")) : {};
  return { ...base, ...inline };
}

/**
 * The named items and everything they require, dependencies first. Base is
 * not included: init installs it, and everything else assumes it.
 * @param {Registry} reg
 * @param {string[]} names
 * @returns {string[]}
 */
export function closure(reg, names) {
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @param {string} n @param {string[]} path */
  const visit = (n, path) => {
    const item = reg.items[n];
    if (!item) throw new Error(`no item named "${n}" (ai-sdlc list shows them)`);
    if (out.includes(n) || n === "base") return;
    if (visiting.has(n)) throw new Error(`a requirement cycle: ${[...path, n].join(" → ")}`);
    visiting.add(n);
    for (const d of item.requires ?? []) visit(d, [...path, n]);
    visiting.delete(n);
    out.push(n);
  };
  for (const n of names) visit(n, []);
  return out;
}
