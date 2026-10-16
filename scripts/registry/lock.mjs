// @ts-check
/**
 * `sdlc.lock.json`: what a project took from the registry, from where, and
 * the SHA-256 of every file as it was copied. That hash is the merge base:
 * with it, `diff` and `update` tell "changed here" from "changed upstream",
 * which is what lets `update` apply upstream fixes without ever overwriting a
 * local edit. Replaces `.sdlc-version`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCK_FILE = "sdlc.lock.json";

/**
 * @typedef {{ repo: string | null, ref: string | null, commit: string | null, path?: string, dirty?: boolean }} SourceId
 * @typedef {{
 *   package: import("./merge.mjs").PackageFragment,
 *   packageJson: string,
 *   config: Record<string, any> | null,
 *   gitignore: string[],
 *   onlyBuiltDependencies: string[],
 * }} Applied
 * A file's `commit` is set only when its recorded hash is older than the item's
 * own commit: an update that leaves a file alone (it was changed here) keeps
 * the hash it was copied at, and the commit that hash can be read back from.
 * @typedef {{ from: string, sha256: string, commit?: string | null }} LockedFile
 * @typedef {{ ref: string | null, commit: string | null, files: Record<string, LockedFile>, applied: Applied }} LockedItem
 * @typedef {{ lockVersion: 1, source: SourceId, items: Record<string, LockedItem> }} Lock
 */

/** @param {Buffer | string} bytes */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @param {string} path @returns {string | null} the file's hash, or null when it is not there */
export function hashFile(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

/**
 * The directory holding sdlc.lock.json, walking up from `start`.
 * @param {string} start
 * @returns {string | null}
 */
export function findProject(start) {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, LOCK_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** @param {string} root @returns {Lock} */
export function readLock(root) {
  const path = join(root, LOCK_FILE);
  /** @type {Lock} */
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${LOCK_FILE} is not readable JSON: ${/** @type {Error} */ (e).message}`);
  }
  if (lock.lockVersion !== 1 || !lock.items || !lock.source)
    throw new Error(`${LOCK_FILE} is not a version 1 lock (lockVersion, source, items)`);
  return lock;
}

/**
 * Written with sorted keys, so a lock's diff is only what changed.
 * @param {string} root
 * @param {Lock} lock
 */
export function writeLock(root, lock) {
  /** @param {unknown} v @returns {unknown} */
  const sort = (v) =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(/** @type {Record<string, unknown>} */ (v)[k])]),
          )
        : v;
  writeFileSync(join(root, LOCK_FILE), `${JSON.stringify(sort(lock), null, 2)}\n`);
}
