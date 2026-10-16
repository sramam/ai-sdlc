/**
 * The pure half of `db:local`: where things live, which port a checkout gets,
 * what a lock file says, and which snapshots to keep. Nothing here touches the
 * network or spawns anything, so all of it is unit-tested directly.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

/** The band `db:local` derives ports from: 55000–55499. */
export const PORT_BASE = 55000;
export const PORT_SLOTS = 500;
/** How many ports past the derived one `start` tries before giving up. */
export const PORT_STEPS = 16;
/** Automatic snapshots (`pre-…`) kept per database; manual ones are never pruned. */
export const AUTO_SNAPSHOTS_KEPT = 5;
export const AUTO_PREFIX = "pre-";
export const SNAPSHOT_EXT = ".tar.gz";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A database name becomes a directory, so it is held to a safe shape. */
export function validName(name: string): boolean {
  return NAME.test(name) && name.length <= 64;
}

/** A snapshot label becomes a file name: no slashes, no dot-dot, no leading dot. */
export function validLabel(label: string): boolean {
  return LABEL.test(label) && !label.includes("..") && label.length <= 100;
}

export interface DbPaths {
  /** `.localdb/<db>/` */
  dir: string;
  /** `.localdb/<db>/data/` — the PGlite data directory. */
  data: string;
  /** `.localdb/<db>/snapshots/` */
  snapshots: string;
  /** `.localdb/<db>/server.json` — the lock, and how to reach a running server. */
  lock: string;
  /** `.localdb/<db>/server.log` — the background server's output, truncated per start. */
  log: string;
}

export function dbPaths(root: string, db: string): DbPaths {
  const dir = join(root, ".localdb", db);
  return {
    dir,
    data: join(dir, "data"),
    snapshots: join(dir, "snapshots"),
    lock: join(dir, "server.json"),
    log: join(dir, "server.log"),
  };
}

export function snapshotFile(paths: DbPaths, label: string): string {
  return join(paths.snapshots, `${label}${SNAPSHOT_EXT}`);
}

/**
 * The checkout's slot for one database. Stable for the life of the path, and
 * different for two databases in one checkout. Distinct across checkouts only
 * probabilistically, which is why `start` probes and steps.
 */
export function derivePort(checkout: string, db: string): number {
  const slot = createHash("sha256").update(`${checkout}\0${db}`).digest().readUInt32BE(0);
  return PORT_BASE + (slot % PORT_SLOTS);
}

/** The derived port, then the ones after it, wrapping inside the band. */
export function candidatePorts(checkout: string, db: string, steps = PORT_STEPS): number[] {
  const first = derivePort(checkout, db) - PORT_BASE;
  return Array.from({ length: steps }, (_, i) => PORT_BASE + ((first + i) % PORT_SLOTS));
}

export function databaseUrl(port: number): string {
  return `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The port of a loopback URL, or null when the URL is not one (or not a URL). */
export function loopbackPort(url: string): number | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  if (!LOOPBACK.has(u.hostname)) return null;
  const port = Number(u.port || "5432");
  return Number.isInteger(port) ? port : null;
}

/**
 * What the lock file holds. `starting` is written by the CLI before it spawns
 * the server; `busy` by an operation on a stopped database (restore, reset);
 * `ready` by the server once it answers.
 */
export interface Lock {
  pid: number;
  state: "starting" | "busy" | "ready";
  /** What a `busy` holder is doing, for the refusal message. */
  op?: string;
  port?: number;
  url?: string;
  control?: { port: number; token: string };
  startedAt: string;
}

export type LockState =
  | { state: "stopped" }
  | { state: "running"; lock: Lock }
  | { state: "starting" | "busy"; lock: Lock }
  | { state: "stale"; pid: number }
  | { state: "unreadable"; reason: string };

/**
 * Three answers, and a fourth that is not one: a lock that names a dead pid is
 * **stale** — a crash or a SIGKILL — and is cleared and said, never trusted. An
 * unreadable lock is *could not ask*: nobody guesses whether that is running.
 */
export function classifyLock(raw: string | null, isAlive: (pid: number) => boolean): LockState {
  if (raw === null) return { state: "stopped" };
  let lock: Lock;
  try {
    lock = JSON.parse(raw) as Lock;
  } catch (err) {
    return { state: "unreadable", reason: `not JSON (${(err as Error).message})` };
  }
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0)
    return { state: "unreadable", reason: "no pid" };
  if (!["starting", "busy", "ready"].includes(lock.state))
    return { state: "unreadable", reason: `unknown state ${JSON.stringify(lock.state)}` };
  if (!isAlive(lock.pid)) return { state: "stale", pid: lock.pid };
  if (lock.state === "ready") {
    if (!lock.port || !lock.url || !lock.control)
      return { state: "unreadable", reason: "ready, but no port, url or control channel" };
    return { state: "running", lock };
  }
  return { state: lock.state, lock };
}

/** `pre-migrate-20261015-101530-123` — sortable, and unique to the millisecond. */
export function autoLabel(kind: "migrate" | "reset", now: Date = new Date()): string {
  const s = now.toISOString(); // 2026-10-15T10:15:30.123Z
  const stamp = `${s.slice(0, 10).replaceAll("-", "")}-${s.slice(11, 19).replaceAll(":", "")}-${s.slice(20, 23)}`;
  return `${AUTO_PREFIX}${kind}-${stamp}`;
}

export interface SnapshotInfo {
  label: string;
  bytes: number;
  mtimeMs: number;
  auto: boolean;
}

/** The automatic snapshots past the newest `keep`, oldest first. Manual ones never. */
export function snapshotsToPrune(list: SnapshotInfo[], keep = AUTO_SNAPSHOTS_KEPT): string[] {
  return list
    .filter((s) => s.auto)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.label.localeCompare(a.label))
    .slice(keep)
    .map((s) => s.label)
    .reverse();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
