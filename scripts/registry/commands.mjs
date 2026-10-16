// @ts-check
/**
 * The CLI's commands: init, add, list, diff and update. Each takes a context
 * (where it runs, how it prints, how it runs a program) and returns an exit
 * code: 0 done, 1 refused or failed, 2 could not ask.
 *
 * The rule under all of them: **a project owns every file it was given.** No
 * command overwrites a file that differs from what was copied. `add` refuses
 * when a target exists with other content; `update` applies an upstream change
 * only to a file still as it was copied, and lists the rest for an agent to
 * fold in by hand.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  addBuiltDependencies,
  equal,
  mergeConfig,
  mergeLines,
  mergePackage,
  PACKAGE_SECTIONS,
} from "./merge.mjs";
import { LOCK_FILE, findProject, hashFile, readLock, sha256, writeLock } from "./lock.mjs";
import {
  closure,
  configFragment,
  expandItem,
  listSourceFiles,
  loadRegistry,
  packageFragment,
  packageJsonOf,
} from "./registry.mjs";
import { DEFAULT_REPO, readAt, resolveSource } from "./source.mjs";

/**
 * @typedef {import("./registry.mjs").Registry} Registry
 * @typedef {import("./registry.mjs").Item} Item
 * @typedef {import("./registry.mjs").Planned} Planned
 * @typedef {import("./lock.mjs").Lock} Lock
 * @typedef {import("./lock.mjs").LockedItem} LockedItem
 * @typedef {import("./lock.mjs").Applied} Applied
 * @typedef {import("./lock.mjs").SourceId} SourceId
 * @typedef {{
 *   cwd: string,
 *   log: (line: string) => void,
 *   version: string,
 *   cliPath: string,
 *   cache?: string,
 *   run?: (cmd: string, args: string[], cwd: string) => number | null,
 * }} Ctx
 * @typedef {{ from?: string, ref?: string, repo?: string }} SourceOpts
 */

/** @param {Ctx} ctx @param {string} cmd @param {string[]} args @param {string} cwd */
function runInherit(ctx, cmd, args, cwd) {
  if (ctx.run) return ctx.run(cmd, args, cwd);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  return r.error ? null : r.status;
}

/** @param {string} cmd @param {string[]} args @param {string} cwd */
const quiet = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: r.error ? null : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

/** @param {string} path @param {Buffer | string} bytes */
function writeFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** @param {string} path @returns {any} */
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
/** @param {string} path @param {unknown} value */
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

/** @param {Ctx} ctx @param {import("./source.mjs").Resolved} r */
function sourceFailed(ctx, r) {
  if (r.ok) return 0;
  ctx.log(`ai-sdlc: ${r.couldNotAsk ? "could not ask" : "refused"}: ${r.reason}`);
  return r.couldNotAsk ? 2 : 1;
}

/** @param {SourceId} id */
const describeSource = (id) =>
  id.path
    ? `${id.path}${id.commit ? ` at ${id.commit.slice(0, 12)}${id.dirty ? " (with uncommitted changes)" : ""}` : ""}`
    : `${id.repo}#${id.ref}${id.commit ? ` (${id.commit.slice(0, 12)})` : ""}`;

/**
 * The project's `sdlc` script: the CLI at the source's ref, so an agent runs
 * the version the lock pins. A local source runs the CLI in that directory.
 * @param {SourceId} id
 */
export function sdlcScript(id) {
  if (id.path) return `node ${join(id.path, "scripts/registry/cli.mjs")}`;
  const repo = id.repo ?? DEFAULT_REPO;
  // pnpm reads `github:owner/name` itself; any other git URL needs `git+`.
  const spec = /^github:/.test(repo) || repo.startsWith("git+") ? repo : `git+${repo}`;
  return `pnpm dlx ${spec}#${id.ref}`;
}

/**
 * What an item merges, as recorded in the lock.
 * @param {Item} item
 * @param {string} sourceDir
 * @returns {Applied}
 */
function appliedOf(item, sourceDir) {
  return {
    package: packageFragment(item, sourceDir),
    packageJson: packageJsonOf(item),
    config: configFragment(item, sourceDir),
    gitignore: item.gitignore ?? [],
    onlyBuiltDependencies: item.onlyBuiltDependencies ?? [],
  };
}

/**
 * Apply an item's merges to the project. Returns what was added and what the
 * project kept of its own.
 * @param {string} root
 * @param {Applied} a
 */
function applyMerges(root, a) {
  /** @type {string[]} */ const added = [];
  /** @type {string[]} */ const kept = [];
  const pkgPath = join(root, a.packageJson);
  if (Object.keys(a.package).length) {
    const m = mergePackage(readJson(pkgPath), a.package);
    if (m.added.length) writeJson(pkgPath, m.pkg);
    added.push(...m.added.map((k) => `${a.packageJson} ${k}`));
    kept.push(...m.kept.map((k) => `${a.packageJson} ${k}`));
  }
  if (a.config) {
    const path = join(root, "sdlc.config.json");
    const before = readJson(path);
    const m = mergeConfig(before, a.config);
    if (!equal(before, m.config)) {
      writeJson(path, m.config);
      added.push("sdlc.config.json: the item's settings");
    }
    kept.push(...m.kept.map((k) => `sdlc.config.json ${k}: kept the project's value`));
  }
  if (a.gitignore.length) {
    const path = join(root, ".gitignore");
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const after = mergeLines(before, `${a.gitignore.join("\n")}\n`);
    if (after !== before) {
      writeFile(path, after);
      added.push(`.gitignore: ${a.gitignore.join(", ")}`);
    }
  }
  if (a.onlyBuiltDependencies.length) {
    const path = join(root, "pnpm-workspace.yaml");
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const after = addBuiltDependencies(before, a.onlyBuiltDependencies);
    if (after !== before) {
      writeFile(path, after);
      added.push(
        `pnpm-workspace.yaml onlyBuiltDependencies: ${a.onlyBuiltDependencies.join(", ")}`,
      );
    }
  }
  return { added, kept };
}

/**
 * Copy an item's files, returning the lock's record of them. Seed files are
 * written only when absent and are not recorded: they are the project's from
 * the first byte (package.json, sdlc.config.json, .gitignore, the workspace).
 * @param {string} root
 * @param {string} sourceDir
 * @param {Planned[]} files
 */
function copyFiles(root, sourceDir, files) {
  /** @type {Record<string, { from: string, sha256: string }>} */
  const record = {};
  for (const f of files) {
    const target = join(root, f.to);
    if (f.seed) {
      if (!existsSync(target)) writeFile(target, readFileSync(join(sourceDir, f.from)));
      continue;
    }
    const bytes = readFileSync(join(sourceDir, f.from));
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(sourceDir, f.from), target);
    }
    record[f.to] = { from: f.from, sha256: sha256(bytes) };
  }
  return record;
}

// ─── init ─────────────────────────────────────────────────────────────────────

/**
 * @param {Ctx} ctx
 * @param {string} dir
 * @param {SourceOpts & { install?: boolean, commit?: boolean }} o
 */
export function init(ctx, dir, o) {
  const root = resolve(ctx.cwd, dir);
  if (existsSync(root) && readdirSync(root).length) {
    ctx.log(
      `ai-sdlc init refused: ${root} is not empty. init creates a project; add items to one with ai-sdlc add.`,
    );
    return 1;
  }
  const src = resolveSource({
    ...o,
    cwd: ctx.cwd,
    defaultRef: `v${ctx.version}`,
    cache: ctx.cache,
  });
  if (!src.ok) return sourceFailed(ctx, src);
  const reg = loadRegistry(src.dir);
  const base = /** @type {Item} */ (reg.items.base);
  const planned = expandItem(base, listSourceFiles(src.dir), "base");
  ctx.log(`ai-sdlc init ${root}`);
  ctx.log(`  source        ${describeSource(src.id)}`);

  mkdirSync(root, { recursive: true });
  const files = copyFiles(root, src.dir, planned);
  const pkgPath = join(root, "package.json");
  const pkg = readJson(pkgPath);
  pkg.name = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  writeJson(pkgPath, pkg);
  const applied = appliedOf(base, src.dir);
  applyMerges(root, applied);
  // The CLI itself, pinned to this source. Not part of base's recorded merge:
  // it names where this project came from, which no upstream can know.
  writeJson(
    pkgPath,
    mergePackage(readJson(pkgPath), { scripts: { sdlc: sdlcScript(src.id) } }).pkg,
  );
  /** @type {Lock} */
  const lock = {
    lockVersion: 1,
    source: src.id,
    items: { base: { ref: src.id.ref, commit: src.id.commit, files, applied } },
  };
  writeLock(root, lock);
  ctx.log(
    `  base          ${Object.keys(files).length} files, plus package.json, sdlc.config.json, ${LOCK_FILE}`,
  );

  const git = quiet("git", ["init", "-q", "-b", "main"], root);
  if (git.code !== 0) {
    ctx.log(
      `  git           could not ask: git init failed (${git.out || "is git installed?"}); nothing committed`,
    );
    return 2;
  }
  ctx.log("  git           initialised on main");
  if (o.install !== false) {
    ctx.log("  install       pnpm install");
    const code = runInherit(ctx, "pnpm", ["install"], root);
    if (code !== 0) {
      ctx.log(`  install       failed (exit ${code}); fix it, then pnpm install and commit`);
      return 1;
    }
  } else
    ctx.log(
      "  install       skipped (--no-install): run pnpm install, which also installs the git hooks",
    );
  if (o.commit !== false) {
    quiet("git", ["add", "."], root);
    const ref = src.id.ref ?? src.id.commit?.slice(0, 12) ?? "a local source";
    const msg = `Create the project with ai-sdlc init\n\nBase item from ${ref}.\n\nNo-Item: created by ai-sdlc init, before any plan item exists\n`;
    const code = runInherit(ctx, "git", ["commit", "-q", "-m", msg], root);
    if (code !== 0) {
      ctx.log(
        `  commit        failed (exit ${code}): the files are staged; commit them when the hooks pass`,
      );
      return 1;
    }
    ctx.log("  commit        the initial commit, through the project's hooks");
  }
  ctx.log("");
  ctx.log("Next:");
  ctx.log(`  cd ${dir}`);
  ctx.log(
    "  gh repo create <owner>/<name> --private --source . --push   # main, to an empty repository",
  );
  ctx.log(
    "  pnpm sdlc:init                                               # dev, settings, the merge rules",
  );
  ctx.log('Then tell your agent: "Read docs/kit/BOOTSTRAP.md and follow it. Start with /kickoff."');
  return 0;
}

// ─── add ──────────────────────────────────────────────────────────────────────

/**
 * @param {Ctx} ctx
 * @returns {{ root: string, lock: Lock } | null}
 */
function project(ctx) {
  const root = findProject(ctx.cwd);
  if (!root) {
    ctx.log(`ai-sdlc: no ${LOCK_FILE} here or above. Create a project with ai-sdlc init.`);
    return null;
  }
  return { root, lock: readLock(root) };
}

/**
 * @param {Ctx} ctx
 * @param {string[]} names
 * @param {SourceOpts} o
 */
export function add(ctx, names, o) {
  const p = project(ctx);
  if (!p) return 1;
  const { root, lock } = p;
  if (!names.length) {
    ctx.log("usage: ai-sdlc add <item…>   (ai-sdlc list shows them)");
    return 1;
  }
  const src = resolveSource({ ...o, lock: lock.source, cwd: ctx.cwd, cache: ctx.cache });
  if (!src.ok) return sourceFailed(ctx, src);
  const reg = loadRegistry(src.dir);
  /** @type {string[]} */
  let order;
  try {
    order = closure(reg, names);
  } catch (e) {
    ctx.log(`ai-sdlc add refused: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
  const todo = order.filter((n) => !lock.items[n]);
  for (const n of names.filter((n) => lock.items[n]))
    ctx.log(`  ${n.padEnd(22)} already installed — ai-sdlc diff ${n} shows what changed upstream`);
  if (!todo.length) return 0;

  const all = new Set([...Object.keys(lock.items), ...todo]);
  /** @type {string[]} */
  const problems = [];
  for (const n of todo)
    for (const c of reg.items[n]?.conflicts ?? [])
      if (all.has(c))
        problems.push(`${n} conflicts with ${c}: they install the same files; choose one`);
  const sourceFiles = listSourceFiles(src.dir);
  /** @type {Map<string, Planned[]>} */
  const plans = new Map();
  /** @type {Map<string, string>} */
  const claimed = new Map();
  for (const n of todo) {
    const plan = expandItem(/** @type {Item} */ (reg.items[n]), sourceFiles, n);
    plans.set(n, plan);
    for (const f of plan) {
      const other = claimed.get(f.to);
      if (other) problems.push(`${f.to}: both ${other} and ${n} install it`);
      claimed.set(f.to, n);
      const target = join(root, f.to);
      if (f.seed || !existsSync(target)) continue;
      if (hashFile(target) !== sha256(readFileSync(join(src.dir, f.from))))
        problems.push(
          `${f.to} exists here with other content (${n} would copy it); move it aside or merge it by hand`,
        );
    }
  }
  for (const n of todo) {
    const pj = packageJsonOf(/** @type {Item} */ (reg.items[n]));
    if (reg.items[n]?.package && !existsSync(join(root, pj)) && !claimed.has(pj))
      problems.push(
        `${n} adds dependencies to ${pj}, which neither exists nor arrives with this add`,
      );
  }
  if (problems.length) {
    ctx.log(`ai-sdlc add refused; nothing was written:`);
    for (const pr of problems) ctx.log(`  ${pr}`);
    return 1;
  }

  ctx.log(`ai-sdlc add ${todo.join(" ")}   (from ${describeSource(src.id)})`);
  /** @type {string[]} */
  const notes = [];
  for (const n of todo) {
    const files = copyFiles(root, src.dir, /** @type {Planned[]} */ (plans.get(n)));
    ctx.log(`  ${n.padEnd(22)} ${Object.keys(files).length} files`);
    lock.items[n] = {
      ref: src.id.ref,
      commit: src.id.commit,
      files,
      applied: appliedOf(/** @type {Item} */ (reg.items[n]), src.dir),
    };
  }
  for (const n of todo) {
    const { added, kept } = applyMerges(root, /** @type {LockedItem} */ (lock.items[n]).applied);
    for (const a of added) ctx.log(`  ${n.padEnd(22)} + ${a}`);
    for (const k of kept) ctx.log(`  ${n.padEnd(22)} kept ${k}`);
    const note = reg.items[n]?.notes;
    if (note) notes.push(`  ${n}: ${note}`);
  }
  if (o.from || o.ref) lock.source = src.id;
  writeLock(root, lock);
  ctx.log(
    "Run pnpm install. Everything added is the project's now: change it as the project needs.",
  );
  if (notes.length) {
    ctx.log("Notes:");
    for (const n of notes) ctx.log(n);
  }
  return 0;
}

// ─── list ─────────────────────────────────────────────────────────────────────

/**
 * @param {Ctx} ctx
 * @param {SourceOpts} o
 */
export function list(ctx, o) {
  const root = findProject(ctx.cwd);
  const lock = root ? readLock(root) : null;
  const src = resolveSource({
    ...o,
    from: o.from ?? (lock ? undefined : resolve(dirname(ctx.cliPath), "..", "..")),
    lock: lock?.source,
    cwd: ctx.cwd,
    cache: ctx.cache,
  });
  if (!src.ok) return sourceFailed(ctx, src);
  const reg = loadRegistry(src.dir);
  ctx.log(`items in ${describeSource(src.id)}${root ? `; installed in ${root}` : ""}`);
  ctx.log(`  ${"item".padEnd(22)}${"kind".padEnd(8)}${"installed".padEnd(16)}requires`);
  for (const [name, item] of Object.entries(reg.items)) {
    const l = lock?.items[name];
    const at = l ? (l.ref ?? l.commit?.slice(0, 12) ?? "local") : "-";
    ctx.log(
      `  ${name.padEnd(22)}${item.kind.padEnd(8)}${at.padEnd(16)}${(item.requires ?? []).join(", ") || "-"}`,
    );
    ctx.log(`  ${"".padEnd(22)}${item.description}`);
  }
  return 0;
}

// ─── diff and update ──────────────────────────────────────────────────────────

/**
 * @typedef {"unchanged" | "changed-upstream" | "locally-modified" | "both-changed"
 *   | "converged" | "added-upstream" | "added-upstream-exists" | "removed-upstream"
 *   | "removed-upstream-modified" | "deleted-locally"} FileState
 * @typedef {{ to: string, state: FileState, from?: string, oldFrom?: string, baseCommit?: string | null, base?: string, local: string | null, upstream?: string }} FileRow
 */

/**
 * Each file of an installed item, against what was copied (the lock) and what
 * the source has now.
 * @param {string} root
 * @param {LockedItem} locked
 * @param {Planned[]} upstream
 * @param {string} sourceDir
 * @returns {FileRow[]}
 */
export function classify(root, locked, upstream, sourceDir) {
  /** @type {FileRow[]} */
  const rows = [];
  const up = new Map(upstream.filter((f) => !f.seed).map((f) => [f.to, f]));
  const paths = [...new Set([...Object.keys(locked.files), ...up.keys()])].sort();
  for (const to of paths) {
    const was = locked.files[to];
    const now = up.get(to);
    const local = hashFile(join(root, to));
    const upstreamHash = now ? sha256(readFileSync(join(sourceDir, now.from))) : undefined;
    /** @type {FileState} */
    let state;
    if (!was)
      state =
        local === null
          ? "added-upstream"
          : local === upstreamHash
            ? "converged"
            : "added-upstream-exists";
    else if (local === null) state = "deleted-locally";
    else if (!now) state = local === was.sha256 ? "removed-upstream" : "removed-upstream-modified";
    else if (local === was.sha256)
      state = upstreamHash === was.sha256 ? "unchanged" : "changed-upstream";
    else if (upstreamHash === was.sha256) state = "locally-modified";
    else state = local === upstreamHash ? "converged" : "both-changed";
    rows.push({
      to,
      state,
      from: now?.from,
      oldFrom: was?.from,
      baseCommit: was ? (was.commit ?? locked.commit) : undefined,
      base: was?.sha256,
      local,
      upstream: upstreamHash,
    });
  }
  return rows;
}

const LABEL = /** @type {Record<FileState, string>} */ ({
  unchanged: "unchanged",
  "changed-upstream": "upstream changed, untouched here: update applies it",
  "locally-modified": "modified here, upstream unchanged: yours",
  "both-changed": "modified here AND upstream: fold the upstream change in by hand",
  converged: "already matches upstream",
  "added-upstream": "new upstream: update copies it",
  "added-upstream-exists": "new upstream, but a different file is already here: merge by hand",
  "removed-upstream": "removed upstream, untouched here: update deletes it",
  "removed-upstream-modified": "removed upstream, modified here: yours to keep or delete",
  "deleted-locally": "deleted here: update leaves it deleted",
});

/**
 * The upstream change to one file as a unified diff, base → upstream, so an
 * agent can apply the same change to its modified copy. Without the base, the
 * project's file against upstream, said so.
 * @param {Ctx} ctx
 * @param {SourceId} baseId
 * @param {FileRow} row
 * @param {string} root
 * @param {string} sourceDir
 */
function showUpstreamChange(ctx, baseId, row, root, sourceDir) {
  if (!row.from) return;
  const tmp = mkdtempSync(join(tmpdir(), "ai-sdlc-diff-"));
  try {
    // The copied version, read from the source at the commit its hash was taken
    // at, and believed only if it hashes to what the lock recorded.
    const read =
      row.oldFrom && row.baseCommit !== undefined
        ? readAt({ ...baseId, commit: row.baseCommit }, row.oldFrom, ctx.cache)
        : null;
    const base = read && sha256(read) === row.base ? read : null;
    const left = join(tmp, "a");
    const label = base
      ? `${row.to} as copied`
      : `${row.to} here (the copied version is not available)`;
    writeFileSync(left, base ?? readFileSync(join(root, row.to)));
    const r = spawnSync(
      "git",
      [
        "diff",
        "--no-index",
        "--no-color",
        "--src-prefix=",
        "--dst-prefix=",
        left,
        join(sourceDir, row.from),
      ],
      { encoding: "utf8" },
    );
    ctx.log(`    --- ${label}`);
    ctx.log(`    +++ ${row.to} upstream`);
    for (const line of (r.stdout ?? "").split("\n").slice(4)) if (line) ctx.log(`    ${line}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The item's merges: what upstream changed since they were applied, and
 * whether the project still holds the old value.
 * @param {string} root
 * @param {Applied} was
 * @param {Applied} now
 */
export function fragmentChanges(root, was, now) {
  /** @type {{ key: string, kind: "added" | "changed" | "removed", local: unknown, old?: unknown, next?: unknown }[]} */
  const out = [];
  const pkgPath = join(root, now.packageJson);
  const pkg = existsSync(pkgPath) ? readJson(pkgPath) : {};
  for (const section of PACKAGE_SECTIONS) {
    const a = was.package[section] ?? {};
    const b = now.package[section] ?? {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const local = pkg[section]?.[k];
      const key = `${now.packageJson} ${section}.${k}`;
      if (!(k in a)) out.push({ key, kind: "added", local, next: b[k] });
      else if (!(k in b)) out.push({ key, kind: "removed", local, old: a[k] });
      else if (a[k] !== b[k]) out.push({ key, kind: "changed", local, old: a[k], next: b[k] });
    }
  }
  if (!equal(was.config, now.config))
    out.push({
      key: "sdlc.config.json (the item's settings)",
      kind: "changed",
      local: null,
      old: was.config,
      next: now.config,
    });
  for (const l of now.gitignore.filter((x) => !was.gitignore.includes(x)))
    out.push({ key: `.gitignore ${l}`, kind: "added", local: null, next: l });
  for (const d of now.onlyBuiltDependencies.filter((x) => !was.onlyBuiltDependencies.includes(x)))
    out.push({ key: `onlyBuiltDependencies ${d}`, kind: "added", local: null, next: d });
  return out;
}

/**
 * @param {Ctx} ctx
 * @param {string} name
 * @param {SourceOpts} o
 */
function prepare(ctx, name, o) {
  const p = project(ctx);
  if (!p) return { ok: /** @type {const} */ (false), code: 1 };
  const locked = p.lock.items[name];
  if (!locked) {
    ctx.log(`ai-sdlc: ${name} is not installed here (ai-sdlc list shows what is).`);
    return { ok: /** @type {const} */ (false), code: 1 };
  }
  const src = resolveSource({ ...o, lock: p.lock.source, cwd: ctx.cwd, cache: ctx.cache });
  if (!src.ok) return { ok: /** @type {const} */ (false), code: sourceFailed(ctx, src) };
  const reg = loadRegistry(src.dir);
  const item = reg.items[name];
  if (!item) {
    ctx.log(
      `ai-sdlc: ${describeSource(src.id)} has no item ${name} any more; its files are the project's.`,
    );
    return { ok: /** @type {const} */ (false), code: 1 };
  }
  const upstream = expandItem(item, listSourceFiles(src.dir), name);
  const rows = classify(p.root, locked, upstream, src.dir);
  const applied = appliedOf(item, src.dir);
  /** @type {SourceId} */
  const baseId = { ...p.lock.source, ref: locked.ref, commit: locked.commit };
  return {
    ok: /** @type {const} */ (true),
    code: 0,
    ...p,
    locked,
    src,
    item,
    rows,
    applied,
    baseId,
  };
}

/**
 * @param {Ctx} ctx
 * @param {string} name
 * @param {SourceOpts} o
 */
export function diff(ctx, name, o) {
  const s = prepare(ctx, name, o);
  if (!s.ok) return s.code;
  ctx.log(
    `ai-sdlc diff ${name}: here (as copied from ${s.locked.ref ?? s.locked.commit?.slice(0, 12) ?? "a local source"}) against ${describeSource(s.src.id)}`,
  );
  const counts = /** @type {Record<string, number>} */ ({});
  for (const r of s.rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  for (const r of s.rows.filter((r) => r.state !== "unchanged")) {
    ctx.log(`  ${r.state.padEnd(26)} ${r.to}   ${LABEL[r.state]}`);
    if (r.state === "both-changed" || r.state === "added-upstream-exists")
      showUpstreamChange(ctx, s.baseId, r, s.root, s.src.dir);
  }
  for (const f of fragmentChanges(s.root, s.locked.applied, s.applied))
    ctx.log(
      `  ${`merge ${f.kind}`.padEnd(26)} ${f.key}${f.kind === "removed" ? "" : ` → ${JSON.stringify(f.next)}`}`,
    );
  ctx.log(
    `  ${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}`,
  );
  return 0;
}

/**
 * @param {Ctx} ctx
 * @param {string} name
 * @param {SourceOpts & { accept?: string[] }} o
 */
export function update(ctx, name, o) {
  const s = prepare(ctx, name, o);
  if (!s.ok) return s.code;
  const { root, lock, locked, rows, src } = s;
  const accept = new Set(o.accept ?? []);
  for (const a of accept)
    if (
      !rows.some(
        (r) => r.to === a && (r.state === "both-changed" || r.state === "added-upstream-exists"),
      )
    ) {
      ctx.log(`ai-sdlc update refused: --accept ${a} names no file waiting on a hand merge`);
      return 1;
    }
  ctx.log(`ai-sdlc update ${name} → ${describeSource(src.id)}`);
  /** @type {Record<string, import("./lock.mjs").LockedFile>} */
  const files = {};
  // A file left as it was keeps its hash, and the commit that hash is from.
  for (const [to, f] of Object.entries(locked.files))
    files[to] = { ...f, commit: f.commit ?? locked.commit };
  /** @type {string[]} */
  const byHand = [];
  for (const r of rows) {
    const record = () => {
      if (r.from && r.upstream) files[r.to] = { from: r.from, sha256: r.upstream };
    };
    switch (r.state) {
      case "changed-upstream":
      case "added-upstream":
        writeFile(join(root, r.to), readFileSync(join(src.dir, /** @type {string} */ (r.from))));
        record();
        ctx.log(`  updated   ${r.to}`);
        break;
      case "converged":
        record();
        break;
      case "unchanged":
        record();
        break;
      case "removed-upstream":
        rmSync(join(root, r.to));
        delete files[r.to];
        ctx.log(`  deleted   ${r.to} (removed upstream)`);
        break;
      case "both-changed":
      case "added-upstream-exists":
        if (accept.has(r.to)) {
          record();
          ctx.log(`  accepted  ${r.to}: recorded as merged with upstream`);
        } else byHand.push(r.to);
        break;
      default:
        // locally-modified, removed-upstream-modified, deleted-locally: the
        // project's. The lock keeps the copied hash, so diff keeps saying so.
        if (r.state === "removed-upstream-modified")
          ctx.log(`  kept      ${r.to} (removed upstream; modified here)`);
    }
  }
  // Merges: add what is new; change a value only where the project still
  // holds the one this item set; report everything else.
  const pkgPath = join(root, s.applied.packageJson);
  /** @type {string[]} */
  const reports = [];
  const changes = fragmentChanges(root, locked.applied, s.applied);
  if (changes.some((c) => c.key.startsWith(s.applied.packageJson))) {
    const pkg = readJson(pkgPath);
    for (const c of changes) {
      const m = /^(\S+) (scripts|dependencies|devDependencies)\.(.+)$/.exec(c.key);
      if (!m || m[1] !== s.applied.packageJson) continue;
      const section = /** @type {"scripts"} */ (m[2]);
      const k = /** @type {string} */ (m[3]);
      pkg[section] ??= {};
      if (c.kind === "removed") {
        if (c.local !== undefined)
          reports.push(`${c.key}: no longer used by ${name}; remove it if nothing else needs it`);
      } else if (c.local === c.next) continue;
      else if (c.kind === "added" && c.local === undefined) pkg[section][k] = c.next;
      else if (c.kind === "changed" && c.local === c.old) pkg[section][k] = c.next;
      else reports.push(`${c.key}: kept "${c.local}", upstream has "${c.next}"`);
      if (pkg[section][k] === c.next && c.local !== c.next)
        ctx.log(`  merged    ${c.key} = ${c.next}`);
    }
    writeJson(pkgPath, pkg);
  }
  const merged = applyMerges(root, { ...s.applied, package: {} });
  for (const a of merged.added) ctx.log(`  merged    ${a}`);
  for (const r of [...reports, ...merged.kept]) ctx.log(`  kept      ${r}`);
  lock.items[name] = { ref: src.id.ref, commit: src.id.commit, files, applied: s.applied };
  if (o.from || o.ref) {
    const oldScript = sdlcScript(lock.source);
    lock.source = src.id;
    const pkg = existsSync(join(root, "package.json"))
      ? readJson(join(root, "package.json"))
      : null;
    if (pkg?.scripts?.sdlc === oldScript) {
      pkg.scripts.sdlc = sdlcScript(src.id);
      writeJson(join(root, "package.json"), pkg);
      ctx.log(`  merged    package.json scripts.sdlc → ${pkg.scripts.sdlc}`);
    }
  }
  writeLock(root, lock);
  if (byHand.length) {
    ctx.log(`${byHand.length} file(s) changed both here and upstream; nothing was overwritten:`);
    for (const b of byHand) ctx.log(`  ${b}`);
    ctx.log(
      `ai-sdlc diff ${name} shows each upstream change. Fold it in, then: ai-sdlc update ${name} --accept <file>`,
    );
  }
  const note = s.item.notes;
  if (note) ctx.log(`Note: ${note}`);
  return 0;
}
