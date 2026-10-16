// @ts-check
/**
 * Where the registry is read from: a local directory (`--from`, for tests and
 * offline use), or a git ref of the registry's repository, fetched shallowly
 * into a cache outside any `node_modules`. Three answers, like every check in
 * the kit: a directory, a refusal, or *could not ask* (no git, no network, a
 * ref that does not exist) — the last is never treated as "nothing to update".
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_REPO = "github:sramam/ai-sdlc";

/**
 * @typedef {import("./lock.mjs").SourceId} SourceId
 * @typedef {{ ok: true, dir: string, id: SourceId } | { ok: false, couldNotAsk: boolean, reason: string }} Resolved
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} [cwd]
 */
export function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    code: r.error ? null : r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? r.error.message : ""),
  };
}

/** @param {string} repo `github:owner/name`, or any URL git accepts */
export function repoUrl(repo) {
  const m = /^github:([\w.-]+\/[\w.-]+)$/.exec(repo);
  return m ? `https://github.com/${m[1]}.git` : repo;
}

/** The cache for fetched sources: `$XDG_CACHE_HOME/ai-sdlc`, else `~/.cache/ai-sdlc`. */
export function cacheDir() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ai-sdlc");
}

/**
 * A local directory as the source. Its commit and whether its tree is dirty are
 * recorded when it is a git checkout, so a later `diff` can read the files as
 * they were (`git show <commit>:<path>`) — and knows not to when it was dirty.
 * @param {string} from
 * @param {string} cwd
 * @returns {Resolved}
 */
export function localSource(from, cwd) {
  const dir = isAbsolute(from) ? from : resolve(cwd, from);
  if (!existsSync(join(dir, "registry.json")))
    return { ok: false, couldNotAsk: false, reason: `${dir} has no registry.json` };
  /** @type {SourceId} */
  const id = { repo: null, ref: null, commit: null, path: dir };
  if (existsSync(join(dir, ".git"))) {
    const head = run("git", ["rev-parse", "HEAD"], dir);
    if (head.code === 0) id.commit = head.stdout.trim();
    const status = run("git", ["status", "--porcelain"], dir);
    id.dirty = status.code !== 0 || status.stdout.trim() !== "";
  }
  return { ok: true, dir, id };
}

/**
 * A ref (branch, tag or commit) of `repo`, fetched at depth 1 into the cache
 * and kept there by commit. A cached commit is not fetched again.
 * @param {string} repo
 * @param {string} ref
 * @param {string} [cache]
 * @returns {Resolved}
 */
export function fetchSource(repo, ref, cache = cacheDir()) {
  if (run("git", ["--version"]).code !== 0)
    return { ok: false, couldNotAsk: true, reason: "git is not installed" };
  if (/^[0-9a-f]{40}$/.test(ref) && existsSync(join(cache, ref, "registry.json")))
    return { ok: true, dir: join(cache, ref), id: { repo, ref, commit: ref } };
  mkdirSync(cache, { recursive: true });
  const tmp = mkdtempSync(join(cache, "fetch-"));
  const git = (/** @type {string[]} */ ...args) =>
    run("git", ["-c", "advice.detachedHead=false", ...args], tmp);
  try {
    git("init", "-q");
    git("remote", "add", "origin", repoUrl(repo));
    const fetched = git("fetch", "-q", "--depth", "1", "origin", ref);
    if (fetched.code !== 0)
      return {
        ok: false,
        couldNotAsk: true,
        reason: `could not fetch ${repo}#${ref}: ${(fetched.stderr.trim().split("\n")[0] ?? "").trim()}`,
      };
    const co = git("checkout", "-q", "FETCH_HEAD");
    if (co.code !== 0)
      return {
        ok: false,
        couldNotAsk: true,
        reason: `could not check out ${ref}: ${co.stderr.trim()}`,
      };
    const commit = git("rev-parse", "HEAD").stdout.trim();
    const dir = join(cache, commit);
    if (existsSync(join(dir, "registry.json"))) rmSync(tmp, { recursive: true, force: true });
    else {
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
    }
    if (!existsSync(join(dir, "registry.json")))
      return { ok: false, couldNotAsk: false, reason: `${repo}#${ref} has no registry.json` };
    return { ok: true, dir, id: { repo, ref, commit } };
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The source a command reads: `--from` wins, then `--ref` against the lock's
 * repository, then the lock's own source.
 * @param {{ from?: string, ref?: string, repo?: string, lock?: SourceId | null, cwd: string, defaultRef?: string, cache?: string }} o
 * @returns {Resolved}
 */
export function resolveSource(o) {
  if (o.from) return localSource(o.from, o.cwd);
  const lock = o.lock ?? null;
  if (!o.ref && !o.repo && lock?.path) {
    if (!existsSync(lock.path))
      return {
        ok: false,
        couldNotAsk: true,
        reason: `the lock's source ${lock.path} is gone; pass --from or --ref`,
      };
    return localSource(lock.path, o.cwd);
  }
  const repo = o.repo ?? lock?.repo ?? DEFAULT_REPO;
  const ref = o.ref ?? lock?.ref ?? o.defaultRef;
  if (!ref)
    return {
      ok: false,
      couldNotAsk: false,
      reason: "no ref: pass --ref <tag|branch|commit> or --from <dir>",
    };
  return fetchSource(repo, ref, o.cache);
}

/**
 * The bytes of `path` as the source had it at the lock's commit: the merge base
 * `diff` shows an upstream change against. Null when it cannot be had (a dirty
 * local source, a commit that is gone) — the caller says so.
 * @param {SourceId} id
 * @param {string} path
 * @param {string} [cache]
 * @returns {Buffer | null}
 */
export function readAt(id, path, cache = cacheDir()) {
  if (!id.commit || id.dirty) return null;
  if (id.path) {
    const r = spawnSync("git", ["show", `${id.commit}:${path}`], {
      cwd: id.path,
      maxBuffer: 64 * 1024 * 1024,
    });
    return r.status === 0 ? r.stdout : null;
  }
  if (!id.repo) return null;
  const got = fetchSource(id.repo, id.commit, cache);
  if (!got.ok) return null;
  const file = join(got.dir, path);
  return existsSync(file) ? readFileSync(file) : null;
}
