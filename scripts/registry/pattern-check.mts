/**
 * The registry's pattern check (docs/kit/principles.md §6): registry.json is a
 * list that matters, so it is counted against the tree rather than trusted.
 *
 *   node scripts/registry/pattern-check.mts       prints the table; exit 1 on a problem
 *
 * It asks, of the source directory:
 *   - every file belongs to exactly one item (as a copied file or a fragment
 *     the item reads), or is excluded with a written reason; no exclusion is stale
 *   - two items install the same path only if each names the other in `conflicts`
 *   - an item's relative imports resolve, **in the project's layout**, to its own
 *     files, base's, or an item it requires; a declared requirement that no
 *     import shows carries a reason in `requiresBecause`; no requirement cycle
 *   - every package an item's code imports is declared by the package.json it
 *     lands under (shipped by the item or one it requires, or merged in by a
 *     package fragment), and one package.json is never given two versions of a name
 *   - base's and the modules' scripts and pinned versions are this repository's
 *     own (its package.json, its lockfile's resolution), and this repository's
 *     sdlc.config.json is the template plus their config fragments
 *
 * Three answers per row: ok, a problem, or could-not-ask (a file it could not
 * read, a lockfile it could not parse) — the last is reported, never a pass.
 */
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, posix } from "node:path";
import { differences, equal, mergeConfig } from "./merge.mjs";
import {
  closure,
  configFragment,
  expandItem,
  fragmentFiles,
  listSourceFiles,
  loadRegistry,
  packageFragment,
  packageJsonOf,
} from "./registry.mjs";
import type { Item, Planned, Registry } from "./registry.mjs";

export interface Row {
  item: string;
  kind: string;
  files: number;
  lines: number;
  requires: string;
  packages: number;
  problems: string[];
}

export interface Result {
  rows: Row[];
  /** Problems that belong to no one item: coverage, the registry's own files. */
  global: string[];
  unknown: string[];
}

const CODE = /\.(m|c)?(j|t)sx?$/;
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/**
 * Import specifiers in code. Comments and template literals are removed first:
 * a test that writes a fixture project carries its imports as text.
 */
export function importsOf(text: string): string[] {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1")
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
  const out = new Set<string>();
  const patterns = [
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) out.add(m[1] as string);
  return [...out];
}

/** The package an import names: `@a/b/c` → `@a/b`, `a/b` → `a`. */
export function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

const isBuiltin = (spec: string) =>
  BUILTIN.has(spec) || BUILTIN.has(packageName(spec)) || /^(node|cloudflare):/.test(spec);

/** The resolved version of each root dependency in a pnpm lockfile, peer suffixes dropped. */
export function lockfileRootVersions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const start = text.indexOf("\n  .:\n");
  if (start < 0) return out;
  const rest = text.slice(start + 6);
  const end = rest.search(/\n {2}\S/);
  const block = end < 0 ? rest : rest.slice(0, end);
  let name: string | null = null;
  for (const line of block.split("\n")) {
    const n = /^ {6}'?([^':]+)'?:\s*$/.exec(line);
    if (n) name = n[1] as string;
    const v = /^ {8}version:\s*(\S+)/.exec(line);
    if (v && name) out.set(name, (v[1] as string).replace(/\(.*$/, ""));
  }
  return out;
}

type Deps = Record<string, string>;
const depsOf = (pkg: Record<string, unknown>): Deps => ({
  ...((pkg.peerDependencies as Deps) ?? {}),
  ...((pkg.devDependencies as Deps) ?? {}),
  ...((pkg.dependencies as Deps) ?? {}),
});

export function registryPatternCheck(root: string): Result {
  const reg: Registry = loadRegistry(root);
  const sourceFiles = listSourceFiles(root);
  const global: string[] = [];
  const unknown: string[] = [];
  const names = Object.keys(reg.items);
  const item = (n: string) => reg.items[n] as Item;

  // ── plans, and who owns each source file ──────────────────────────────────
  const plans = new Map<string, Planned[]>();
  const owners = new Map<string, string[]>();
  const own = (path: string, n: string) => owners.set(path, [...(owners.get(path) ?? []), n]);
  for (const n of names) {
    try {
      const plan = expandItem(item(n), sourceFiles, n);
      plans.set(n, plan);
      for (const f of plan) own(f.from, n);
    } catch (e) {
      global.push((e as Error).message);
      plans.set(n, []);
    }
    for (const f of fragmentFiles(item(n))) {
      if (!sourceFiles.includes(f)) global.push(`${n}: fragment ${f} does not exist`);
      own(f, n);
    }
  }
  const excluded = (p: string) =>
    Object.keys(reg.exclude).filter((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
  for (const e of Object.keys(reg.exclude)) {
    if (!sourceFiles.some((p) => (e.endsWith("/") ? p.startsWith(e) : p === e)))
      global.push(`exclude "${e}" matches no file: remove it`);
    if ((reg.exclude[e] ?? "").trim().split(/\s+/).length < 4)
      global.push(`exclude "${e}" needs a reason, not a label`);
  }
  for (const p of sourceFiles) {
    const o = owners.get(p) ?? [];
    const x = excluded(p);
    if (o.length + (x.length ? 1 : 0) === 0)
      global.push(`${p} belongs to no item and is not excluded`);
    else if (o.length > 1) global.push(`${p} belongs to ${o.join(" and ")}`);
    else if (o.length && x.length) global.push(`${p} belongs to ${o[0]} and is excluded`);
  }

  // ── requirements: declared, cycles, conflicts ─────────────────────────────
  const reqClosure = new Map<string, Set<string>>();
  for (const n of names) {
    try {
      reqClosure.set(n, new Set(["base", ...closure(reg, [n])]));
    } catch (e) {
      global.push((e as Error).message);
      reqClosure.set(n, new Set(["base", n]));
    }
  }
  for (const n of names)
    for (const c of item(n).conflicts ?? [])
      if (!(item(c).conflicts ?? []).includes(n))
        global.push(`${n} conflicts with ${c}, but ${c} does not name ${n}`);

  // ── the project's layout: who installs each target path ───────────────────
  const targets = new Map<string, string[]>();
  for (const n of names)
    for (const f of plans.get(n) ?? []) targets.set(f.to, [...(targets.get(f.to) ?? []), n]);
  for (const [to, ns] of targets)
    for (const a of ns)
      for (const b of ns)
        if (a < b && !(item(a).conflicts ?? []).includes(b))
          global.push(`${to} is installed by both ${a} and ${b}, which do not declare a conflict`);

  // ── package.json files in target space, and what each declares ────────────
  const shipped = new Map<string, { item: string; deps: Deps; name?: string }[]>();
  for (const n of names)
    for (const f of plans.get(n) ?? [])
      if (posix.basename(f.to) === "package.json") {
        try {
          const pkg = JSON.parse(readFileSync(join(root, f.from), "utf8"));
          shipped.set(f.to, [
            ...(shipped.get(f.to) ?? []),
            { item: n, deps: depsOf(pkg), name: pkg.name },
          ]);
        } catch (e) {
          unknown.push(`${n}: could not read ${f.from}: ${(e as Error).message}`);
        }
      }
  const fragments = new Map<string, { item: string; deps: Deps }[]>();
  for (const n of names) {
    const frag = packageFragment(item(n), root);
    const deps = { ...(frag.devDependencies ?? {}), ...(frag.dependencies ?? {}) };
    const pj = packageJsonOf(item(n));
    fragments.set(pj, [...(fragments.get(pj) ?? []), { item: n, deps }]);
  }
  // One package.json, one version per name — across what ships it and what merges into it.
  for (const pj of new Set([...shipped.keys(), ...fragments.keys()])) {
    const seen = new Map<string, { v: string; by: string }>();
    for (const s of [...(shipped.get(pj) ?? []), ...(fragments.get(pj) ?? [])])
      for (const [dep, v] of Object.entries(s.deps)) {
        const had = seen.get(dep);
        if (had && had.v !== v && !v.startsWith("workspace:"))
          global.push(`${pj}: ${dep} is ${had.v} for ${had.by} and ${v} for ${s.item}`);
        else if (!had) seen.set(dep, { v, by: s.item });
      }
  }

  /** What `pj` declares when exactly the items in `set` are installed. */
  const declared = (pj: string, set: Set<string>): Deps | null => {
    const ships = (shipped.get(pj) ?? []).filter((s) => set.has(s.item));
    const merges = (fragments.get(pj) ?? []).filter((s) => set.has(s.item));
    if (!ships.length && !merges.length) return null;
    return Object.assign({}, ...ships.map((s) => s.deps), ...merges.map((s) => s.deps));
  };
  const packageFiles = new Set([...shipped.keys(), ...fragments.keys()]);
  /**
   * The package.json files above a target path that this set of items
   * provides, nearest first. Node resolves a bare import by walking up through
   * every node_modules, so a package any of them declares is reachable (the
   * modules' tests reach the root's vitest that way).
   */
  const enclosing = (to: string, set: Set<string>): string[] => {
    const out: string[] = [];
    let dir = posix.dirname(to);
    for (;;) {
      const pj = dir === "." ? "package.json" : `${dir}/package.json`;
      if (packageFiles.has(pj) && declared(pj, set)) out.push(pj);
      if (dir === ".") return out;
      dir = posix.dirname(dir);
    }
  };
  const resolveTarget = (from: string, spec: string): string | null => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const tries = [
      base,
      ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".d.ts"].map((e) => base + e),
      ...["/index.ts", "/index.tsx", "/index.mts", "/index.js"].map((e) => base + e),
    ];
    return tries.find((t) => targets.has(t)) ?? null;
  };

  // ── the registry's own package.json, lockfile and config ──────────────────
  let rootPkg: Record<string, Record<string, string>> = {};
  let resolved = new Map<string, string>();
  try {
    rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    resolved = lockfileRootVersions(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
    if (!resolved.size) unknown.push("pnpm-lock.yaml: could not find the root importer");
  } catch (e) {
    unknown.push(
      `could not read this repository's package.json or lockfile: ${(e as Error).message}`,
    );
  }
  const ownScripts = new Set<string>();
  const ownDeps = new Set<string>();

  // ── per item ──────────────────────────────────────────────────────────────
  const rows: Row[] = [];
  for (const n of names) {
    const it = item(n);
    const problems: string[] = [];
    const plan = plans.get(n) ?? [];
    const set = reqClosure.get(n) as Set<string>;
    const derived = new Set<string>();
    const packages = new Set<string>();
    let lines = 0;
    for (const f of plan) {
      let text: string;
      try {
        text = readFileSync(join(root, f.from), "utf8");
      } catch (e) {
        unknown.push(`${n}: could not read ${f.from}: ${(e as Error).message}`);
        continue;
      }
      lines += text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      if (!CODE.test(f.to)) continue;
      for (const spec of importsOf(text)) {
        // An external ending in "/" is a prefix; otherwise it names a package or a file exactly.
        const external = Object.keys(it.external ?? {}).find((p) =>
          p.endsWith("/") ? spec.startsWith(p) : spec === p || packageName(spec) === p,
        );
        if (external) continue;
        if (spec.startsWith(".")) {
          const target = resolveTarget(f.to, spec);
          if (!target) {
            problems.push(
              `${f.from} imports ${spec}, which no item installs at ${posix.join(posix.dirname(f.to), spec)}`,
            );
            continue;
          }
          const by = targets.get(target) ?? [];
          if (by.includes(n)) continue;
          const reachable = by.filter((b) => set.has(b));
          if (!reachable.length)
            problems.push(
              `${f.from} imports ${spec} (${target}), from ${by.join(" or ")}, which ${n} does not require`,
            );
          for (const b of reachable) if (b !== "base") derived.add(b);
          continue;
        }
        if (isBuiltin(spec)) continue;
        const name = packageName(spec);
        packages.add(name);
        const chain = enclosing(f.to, set);
        const nearest = chain[0];
        const selfName = nearest
          ? (shipped.get(nearest) ?? []).find((s) => set.has(s.item))?.name
          : undefined;
        if (name === selfName) continue;
        if (!chain.some((pj) => name in (declared(pj, set) ?? {})))
          problems.push(
            `${f.from} imports ${name}, which ${chain.length ? chain.join(" and ") : `no package.json above ${f.to}`} does not declare`,
          );
      }
    }
    // Workspace links between modules are requirements too.
    for (const s of [...shipped.values()].flat().filter((s) => s.item === n))
      for (const [dep, v] of Object.entries(s.deps))
        if (v.startsWith("workspace:")) {
          const owner = [...shipped.values()].flat().find((x) => x.name === dep)?.item;
          if (!owner) problems.push(`depends on ${dep} (workspace), which no item ships`);
          else if (!set.has(owner))
            problems.push(
              `depends on ${dep} (workspace), from ${owner}, which ${n} does not require`,
            );
        }
    const declaredReq = new Set(it.requires ?? []);
    for (const d of derived)
      if (!declaredReq.has(d) && ![...declaredReq].some((r) => reqClosure.get(r)?.has(d)))
        problems.push(`imports from ${d} without requiring it`);
    for (const d of declaredReq)
      if (!derived.has(d) && !it.requiresBecause?.[d])
        problems.push(
          `requires ${d}, but nothing it ships imports from ${d}: say why in requiresBecause, or drop it`,
        );
    for (const d of Object.keys(it.requiresBecause ?? {}))
      if (!declaredReq.has(d))
        problems.push(`requiresBecause names ${d}, which it does not require`);
    for (const e of Object.keys(it.external ?? {}))
      if ((it.external?.[e] ?? "").trim().split(/\s+/).length < 3)
        problems.push(`external "${e}" needs a reason`);
    // An agent decides from `pnpm sdlc list` whether to add an item, so every
    // optional one says when a project needs it.
    if (it.kind !== "base" && (it.when ?? "").trim().split(/\s+/).length < 4)
      problems.push("when: say, in a sentence, when a project adds it (pnpm sdlc list prints it)");

    // Base and modules are developed here: their fragments are this repository's own.
    if (it.kind !== "recipe" && packageJsonOf(it) === "package.json") {
      const frag = packageFragment(it, root);
      for (const [k, v] of Object.entries(frag.scripts ?? {})) {
        ownScripts.add(k);
        if (reg.registryOnly.omit?.[k]) {
          if (rootPkg.scripts?.[k] !== undefined)
            problems.push(`script ${k} is in registryOnly.omit, yet package.json has it`);
        } else if (rootPkg.scripts?.[k] !== v)
          problems.push(`script ${k} is "${v}" here and "${rootPkg.scripts?.[k]}" in package.json`);
      }
      for (const [k, v] of Object.entries({ ...frag.dependencies, ...frag.devDependencies })) {
        ownDeps.add(k);
        if (!rootPkg.devDependencies?.[k] && !rootPkg.dependencies?.[k])
          problems.push(`${k} is not a dependency of this repository`);
        else if (resolved.size && resolved.get(k) !== v)
          problems.push(
            `${k} is pinned to ${v}, and this repository's lockfile resolves ${resolved.get(k) ?? "nothing"}`,
          );
      }
    }
    const req = [...declaredReq].join(", ");
    rows.push({
      item: n,
      kind: it.kind,
      files: plan.filter((f) => !f.seed).length + plan.filter((f) => f.seed).length,
      lines,
      requires: req || "-",
      packages: packages.size,
      problems,
    });
  }

  for (const k of Object.keys(rootPkg.scripts ?? {}))
    if (!ownScripts.has(k) && !reg.registryOnly.scripts[k])
      global.push(`package.json script ${k} belongs to no item and is not in registryOnly.scripts`);
  for (const k of Object.keys(reg.registryOnly.scripts))
    if (!rootPkg.scripts?.[k])
      global.push(`registryOnly.scripts names ${k}, which package.json does not have`);
  for (const k of Object.keys({ ...rootPkg.devDependencies, ...rootPkg.dependencies }))
    if (!ownDeps.has(k)) global.push(`package.json dependency ${k} belongs to no item`);

  // This repository's sdlc.config.json: the template plus base's and the modules' fragments.
  try {
    let expected = JSON.parse(readFileSync(join(root, "template/sdlc.config.json"), "utf8"));
    for (const n of names)
      if (item(n).kind !== "recipe") {
        const frag = configFragment(item(n), root);
        if (frag) expected = mergeConfig(expected, frag).config;
      }
    const actual = JSON.parse(readFileSync(join(root, "sdlc.config.json"), "utf8"));
    const byName = (c: { ci: { steps: { name: string }[] } }) => ({
      ...c,
      ci: { ...c.ci, steps: [...c.ci.steps].sort((a, b) => a.name.localeCompare(b.name)) },
    });
    if (!equal(byName(expected), byName(actual)))
      global.push(
        `sdlc.config.json is not template/sdlc.config.json plus the modules' fragments (differs at ${[...differences(byName(actual), byName(expected)), ...differences(byName(expected), byName(actual))].join(", ")})`,
      );
  } catch (e) {
    unknown.push(`could not compare sdlc.config.json: ${(e as Error).message}`);
  }
  return { rows, global, unknown };
}

export function printResult(r: Result, log: (l: string) => void = console.log): number {
  log(
    `  ${"item".padEnd(22)}${"kind".padEnd(8)}${"files".padStart(6)}${"lines".padStart(8)}${"pkgs".padStart(6)}  requires`,
  );
  for (const row of r.rows) {
    log(
      `  ${row.item.padEnd(22)}${row.kind.padEnd(8)}${String(row.files).padStart(6)}${String(row.lines).padStart(8)}${String(row.packages).padStart(6)}  ${row.requires}${row.problems.length ? "   PROBLEM" : ""}`,
    );
    for (const p of row.problems) log(`      ${p}`);
  }
  for (const g of r.global) log(`  PROBLEM  ${g}`);
  for (const u of r.unknown) log(`  COULD NOT ASK  ${u}`);
  const bad = r.global.length + r.rows.reduce((s, x) => s + x.problems.length, 0);
  log(
    bad ? `  ${bad} problem(s)` : r.unknown.length ? "  could not ask everything (above)" : "  ok",
  );
  return bad ? 1 : r.unknown.length ? 2 : 0;
}

if (process.argv[1] === import.meta.filename) {
  console.log("registry pattern check");
  process.exit(printResult(registryPatternCheck(join(dirname(import.meta.filename), "..", ".."))));
}
