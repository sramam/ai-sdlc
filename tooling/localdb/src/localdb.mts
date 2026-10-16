/**
 * The operations behind `pnpm db:local`. Each one prints a line per thing it
 * did — on success too — and returns one of three answers:
 *
 *   ok             it happened, and was checked
 *   failed         a definite no: refused, or tried and it did not work
 *   could-not-ask  the state could not be read (a busy or unreadable lock, a
 *                  server whose pid is alive but whose port does not answer)
 *
 * Snapshots are PGlite `dumpDataDir("gzip")` tarballs. A running server dumps
 * its own data directory when asked over its control channel, so a snapshot
 * never needs a stop; a stopped database is opened in-process to dump or load.
 * One format either way, and a restore is `PGlite.create({ loadDataDir })`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { exec as realExec, formatDuration } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import type { LocaldbDatabase } from "../../core/src/config.mts";
import {
  AUTO_PREFIX,
  PORT_BASE,
  PORT_SLOTS,
  SNAPSHOT_EXT,
  autoLabel,
  classifyLock,
  dbPaths,
  formatAge,
  formatBytes,
  snapshotFile,
  snapshotsToPrune,
  validLabel,
} from "./lib.mts";
import type { DbPaths, Lock, LockState, SnapshotInfo } from "./lib.mts";
import { choosePort, portIsFree } from "./ports.mts";
import { answers } from "./wire.mts";

export type Outcome = "ok" | "failed" | "could-not-ask";

export interface Ctx {
  /** The checkout: the directory holding sdlc.config.json. */
  root: string;
  log: (line: string) => void;
  exec?: Exec;
  isFree?: (port: number) => Promise<boolean>;
  /** Milliseconds to wait for a spawned server to report ready. */
  startTimeoutMs?: number;
}

const SERVER_SCRIPT = join(import.meta.dirname, "server.mts");
const TAG = { ok: "ok   ", failed: "FAIL ", "could-not-ask": "??   " } as const;

function say(ctx: Ctx, outcome: Outcome | "info", db: string, text: string): void {
  ctx.log(`${outcome === "info" ? "     " : TAG[outcome]} ${db}: ${text}`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is simply not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(paths: DbPaths): LockState {
  let raw: string;
  try {
    raw = readFileSync(paths.lock, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "stopped" };
    return { state: "unreadable", reason: (err as Error).message };
  }
  return classifyLock(raw, isAlive);
}

/** Take the lock for an operation, failing if anybody else holds it. */
function claim(paths: DbPaths, state: "starting" | "busy", op: string): boolean {
  const lock: Lock = { pid: process.pid, state, op, startedAt: new Date().toISOString() };
  mkdirSync(paths.dir, { recursive: true });
  try {
    writeFileSync(paths.lock, `${JSON.stringify(lock)}\n`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Drop the lock, but only if this process still holds it. */
function release(paths: DbPaths): void {
  try {
    if ((JSON.parse(readFileSync(paths.lock, "utf8")) as Lock).pid === process.pid)
      rmSync(paths.lock, { force: true });
  } catch {
    // Gone already.
  }
}

/**
 * Settle a lock state into "free to act" or a reason not to. A stale lock is
 * cleared and said; anything held or unreadable is could-not-ask.
 */
function settle(ctx: Ctx, db: string, paths: DbPaths, st: LockState): "free" | "running" | "held" {
  if (st.state === "stale") {
    rmSync(paths.lock, { force: true });
    say(ctx, "info", db, `cleared a stale lock (pid ${st.pid} is gone — a crash or a kill)`);
    return "free";
  }
  if (st.state === "stopped") return "free";
  if (st.state === "running") return "running";
  if (st.state === "unreadable")
    say(
      ctx,
      "could-not-ask",
      db,
      `lock ${paths.lock} is unreadable (${st.reason}); inspect it, then delete it if no server is running`,
    );
  else
    say(
      ctx,
      "could-not-ask",
      db,
      `pid ${st.lock.pid} is ${st.state === "starting" ? "starting it" : `busy (${st.lock.op ?? "?"})`}; try again shortly`,
    );
  return "held";
}

function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((sum, entry) => sum + dirSize(join(path, entry)), 0);
}

export function listSnapshots(paths: DbPaths): SnapshotInfo[] {
  if (!existsSync(paths.snapshots)) return [];
  return readdirSync(paths.snapshots)
    .filter((f) => f.endsWith(SNAPSHOT_EXT))
    .map((f) => {
      const s = statSync(join(paths.snapshots, f));
      const label = f.slice(0, -SNAPSHOT_EXT.length);
      return { label, bytes: s.size, mtimeMs: s.mtimeMs, auto: label.startsWith(AUTO_PREFIX) };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.label.localeCompare(a.label));
}

function prune(ctx: Ctx, db: string, paths: DbPaths): void {
  for (const label of snapshotsToPrune(listSnapshots(paths))) {
    rmSync(snapshotFile(paths, label), { force: true });
    say(ctx, "info", db, `pruned automatic snapshot ${label}`);
  }
}

/** The URL of a running database, or why there is none. */
export async function runningUrl(
  root: string,
  db: string,
): Promise<
  | { state: "running"; url: string; port: number }
  | { state: "stopped" | "could-not-ask"; reason: string }
> {
  const st = readLock(dbPaths(root, db));
  if (st.state === "running") {
    if (await answers(st.lock.port!))
      return { state: "running", url: st.lock.url!, port: st.lock.port! };
    return {
      state: "could-not-ask",
      reason: `pid ${st.lock.pid} is alive but port ${st.lock.port} does not answer`,
    };
  }
  if (st.state === "stopped" || st.state === "stale")
    return { state: "stopped", reason: "not running" };
  if (st.state === "unreadable")
    return { state: "could-not-ask", reason: `lock unreadable (${st.reason})` };
  return { state: "could-not-ask", reason: `${st.state} (pid ${st.lock.pid})` };
}

function tail(path: string, lines = 12): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no server log)";
  }
}

export async function start(
  ctx: Ctx,
  database: LocaldbDatabase,
  opts: { hint?: boolean } = {},
): Promise<Outcome> {
  const db = database.name;
  const paths = dbPaths(ctx.root, db);
  const st = readLock(paths);
  const settled = settle(ctx, db, paths, st);
  if (settled === "held") return "could-not-ask";
  if (settled === "running" && st.state === "running") {
    if (await answers(st.lock.port!)) {
      say(ctx, "ok", db, `already running (pid ${st.lock.pid}) — ${st.lock.url}`);
      return "ok";
    }
    say(
      ctx,
      "could-not-ask",
      db,
      `pid ${st.lock.pid} is alive but port ${st.lock.port} does not answer — pnpm db:local stop ${db}`,
    );
    return "could-not-ask";
  }

  const choice = await choosePort(ctx.root, db, ctx.isFree ?? portIsFree);
  if (!choice) {
    say(
      ctx,
      "failed",
      db,
      `no free port among the candidates in ${PORT_BASE}–${PORT_BASE + PORT_SLOTS - 1}`,
    );
    return "failed";
  }
  if (choice.held.length)
    say(
      ctx,
      "info",
      db,
      `port${choice.held.length > 1 ? "s" : ""} ${choice.held.join(", ")} held by somebody else; stepped to ${choice.port}`,
    );

  const fresh = !existsSync(paths.data);
  if (!claim(paths, "starting", "start")) {
    say(ctx, "could-not-ask", db, "another process took the lock just now; try again");
    return "could-not-ask";
  }
  const out = openSync(paths.log, "w");
  const child = spawn(
    process.execPath,
    [
      SERVER_SCRIPT,
      "--name",
      db,
      "--data",
      paths.data,
      "--snapshots",
      paths.snapshots,
      "--lock",
      paths.lock,
      "--port",
      String(choice.port),
    ],
    { detached: true, stdio: ["ignore", out, out], cwd: ctx.root },
  );
  closeSync(out);
  let exited: number | null | undefined;
  child.on("exit", (code) => (exited = code));
  child.unref();

  const deadline = Date.now() + (ctx.startTimeoutMs ?? 60_000);
  let ready: Lock | null = null;
  while (Date.now() < deadline && exited === undefined) {
    const now = readLock(paths);
    if (now.state === "running" && now.lock.pid === child.pid) {
      ready = now.lock;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    if (exited === undefined && child.pid) process.kill(child.pid, "SIGKILL");
    release(paths);
    say(
      ctx,
      "failed",
      db,
      `server ${exited === undefined ? "did not report ready in time" : `exited (${exited})`}; its log:\n${tail(paths.log)}`,
    );
    return "failed";
  }
  if (!(await answers(ready.port!))) {
    say(
      ctx,
      "failed",
      db,
      `server pid ${ready.pid} reported ready but port ${ready.port} does not answer; log: ${paths.log}`,
    );
    return "failed";
  }
  say(ctx, "ok", db, `running (pid ${ready.pid}) — ${ready.url}`);
  if (fresh && opts.hint !== false)
    say(
      ctx,
      "info",
      db,
      database.migrate
        ? `new, empty database — apply migrations with: pnpm db:local migrate ${db}`
        : "new, empty database",
    );
  return "ok";
}

function commandOf(pid: number): string | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function stop(ctx: Ctx, database: LocaldbDatabase): Promise<Outcome> {
  const db = database.name;
  const paths = dbPaths(ctx.root, db);
  const st = readLock(paths);
  if (st.state === "stopped") {
    say(ctx, "ok", db, "not running");
    return "ok";
  }
  const settled = settle(ctx, db, paths, st);
  if (settled === "held") return "could-not-ask";
  if (settled === "free") {
    say(ctx, "ok", db, "not running");
    return "ok";
  }
  const pid = (st as { lock: Lock }).lock.pid;
  // A pid is reused; make sure it is still our server before signalling it.
  const cmd = commandOf(pid);
  if (cmd !== null && !cmd.includes("server.mts")) {
    rmSync(paths.lock, { force: true });
    say(ctx, "ok", db, `not running (pid ${pid} now belongs to another program; cleared the lock)`);
    return "ok";
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  let note = "";
  if (isAlive(pid)) {
    process.kill(pid, "SIGKILL");
    note = " — did not stop on SIGTERM in 15s and was killed";
  }
  try {
    if ((JSON.parse(readFileSync(paths.lock, "utf8")) as Lock).pid === pid)
      rmSync(paths.lock, { force: true });
  } catch {
    // Removed by the server itself, which is the clean path.
  }
  say(ctx, "ok", db, `stopped (pid ${pid})${note}`);
  return "ok";
}

export async function status(ctx: Ctx, database: LocaldbDatabase): Promise<Outcome> {
  const db = database.name;
  const paths = dbPaths(ctx.root, db);
  const st = readLock(paths);
  const size = formatBytes(dirSize(paths.data));
  const last = listSnapshots(paths)[0];
  const snap = last
    ? `last snapshot ${last.label} (${formatAge(Date.now() - last.mtimeMs)})`
    : "no snapshots";
  if (st.state === "running") {
    if (await answers(st.lock.port!)) {
      say(ctx, "ok", db, `running  port ${st.lock.port}  ${size}  ${snap}  ${st.lock.url}`);
      return "ok";
    }
    say(
      ctx,
      "could-not-ask",
      db,
      `pid ${st.lock.pid} alive, port ${st.lock.port} not answering  ${size}  ${snap}`,
    );
    return "could-not-ask";
  }
  if (st.state === "stopped" || st.state === "stale") {
    const note = st.state === "stale" ? ` (stale lock, pid ${st.pid} gone)` : "";
    say(ctx, "ok", db, `stopped${note}  ${existsSync(paths.data) ? size : "no data yet"}  ${snap}`);
    return "ok";
  }
  if (st.state === "unreadable")
    say(ctx, "could-not-ask", db, `lock unreadable (${st.reason})  ${size}  ${snap}`);
  else
    say(
      ctx,
      "could-not-ask",
      db,
      `${st.state} (pid ${st.lock.pid}${st.lock.op ? `, ${st.lock.op}` : ""})  ${size}  ${snap}`,
    );
  return "could-not-ask";
}

export async function url(ctx: Ctx, database: LocaldbDatabase): Promise<Outcome> {
  const r = await runningUrl(ctx.root, database.name);
  if (r.state === "running") {
    ctx.log(r.url);
    return "ok";
  }
  console.error(
    `${database.name}: ${r.reason}${r.state === "stopped" ? ` — pnpm db:local start ${database.name}` : ""}`,
  );
  return r.state === "stopped" ? "failed" : "could-not-ask";
}

/** Dump a stopped database's data directory in-process. The caller holds the lock. */
async function dumpStopped(paths: DbPaths, label: string): Promise<number> {
  const pg = await PGlite.create({ dataDir: paths.data });
  try {
    const dump = await pg.dumpDataDir("gzip");
    const bytes = Buffer.from(await dump.arrayBuffer());
    mkdirSync(paths.snapshots, { recursive: true });
    const file = snapshotFile(paths, label);
    writeFileSync(`${file}.${process.pid}.tmp`, bytes);
    renameSync(`${file}.${process.pid}.tmp`, file);
    return bytes.length;
  } finally {
    await pg.close();
  }
}

export async function snapshot(
  ctx: Ctx,
  database: LocaldbDatabase,
  label: string,
  opts: { force?: boolean } = {},
): Promise<Outcome> {
  const db = database.name;
  const paths = dbPaths(ctx.root, db);
  if (!validLabel(label)) {
    say(
      ctx,
      "failed",
      db,
      `invalid label ${JSON.stringify(label)} — letters, digits, ".", "_", "-"`,
    );
    return "failed";
  }
  if (existsSync(snapshotFile(paths, label)) && !opts.force) {
    say(ctx, "failed", db, `snapshot ${label} exists — pass --force to replace it`);
    return "failed";
  }
  const st = readLock(paths);
  const settled = settle(ctx, db, paths, st);
  if (settled === "held") return "could-not-ask";
  if (settled === "running" && st.state === "running") {
    const { port, token } = st.lock.control!;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/snapshot?label=${encodeURIComponent(label)}`,
        {
          method: "POST",
          headers: { "x-localdb-token": token },
          signal: AbortSignal.timeout(300_000),
        },
      );
      const body = (await res.json()) as { ok: boolean; bytes?: number; error?: string };
      if (!body.ok) {
        say(ctx, "failed", db, `snapshot ${label}: the server refused — ${body.error}`);
        return "failed";
      }
      say(
        ctx,
        "ok",
        db,
        `snapshot ${label} (${formatBytes(body.bytes ?? 0)}, taken while running)`,
      );
      return "ok";
    } catch (err) {
      say(
        ctx,
        "could-not-ask",
        db,
        `snapshot ${label}: the server's control channel did not answer (${(err as Error).message})`,
      );
      return "could-not-ask";
    }
  }
  if (!existsSync(paths.data)) {
    say(ctx, "failed", db, "no data to snapshot — it has never been started");
    return "failed";
  }
  if (!claim(paths, "busy", `snapshot ${label}`)) {
    say(ctx, "could-not-ask", db, "another process took the lock just now; try again");
    return "could-not-ask";
  }
  try {
    const bytes = await dumpStopped(paths, label);
    say(ctx, "ok", db, `snapshot ${label} (${formatBytes(bytes)}, taken while stopped)`);
    return "ok";
  } catch (err) {
    say(ctx, "failed", db, `snapshot ${label}: ${(err as Error).message}`);
    return "failed";
  } finally {
    release(paths);
  }
}

export async function restore(
  ctx: Ctx,
  database: LocaldbDatabase,
  label: string,
  opts: { force?: boolean } = {},
): Promise<Outcome> {
  const db = database.name;
  const paths = dbPaths(ctx.root, db);
  const file = snapshotFile(paths, label);
  if (!validLabel(label) || !existsSync(file)) {
    const have = listSnapshots(paths).map((s) => s.label);
    say(
      ctx,
      "failed",
      db,
      `no snapshot ${JSON.stringify(label)} — ${have.length ? `have: ${have.join(", ")}` : "none taken yet"}`,
    );
    return "failed";
  }
  const st = readLock(paths);
  const settled = settle(ctx, db, paths, st);
  if (settled === "held") return "could-not-ask";
  let restart = false;
  if (settled === "running") {
    if (!opts.force) {
      say(
        ctx,
        "failed",
        db,
        `running — restore replaces its data. pnpm db:local stop ${db} first, or pass --force to stop, restore and start again`,
      );
      return "failed";
    }
    if ((await stop(ctx, database)) !== "ok") return "failed";
    restart = true;
  }
  if (!claim(paths, "busy", `restore ${label}`)) {
    say(ctx, "could-not-ask", db, "another process took the lock just now; try again");
    return "could-not-ask";
  }
  const aside = `${paths.data}.before-restore-${process.pid}`;
  try {
    if (existsSync(paths.data)) renameSync(paths.data, aside);
    const pg = await PGlite.create({
      dataDir: paths.data,
      loadDataDir: new Blob([readFileSync(file)]),
    });
    await pg.query("select 1");
    await pg.close();
    rmSync(aside, { recursive: true, force: true });
    say(ctx, "ok", db, `restored ${label}`);
  } catch (err) {
    rmSync(paths.data, { recursive: true, force: true });
    if (existsSync(aside)) renameSync(aside, paths.data);
    say(
      ctx,
      "failed",
      db,
      `restore ${label}: ${(err as Error).message} — the previous data is back in place`,
    );
    return "failed";
  } finally {
    release(paths);
  }
  return restart ? start(ctx, database) : "ok";
}

/** Run the configured migrate command against the running database. No snapshot. */
async function runMigrate(
  ctx: Ctx,
  database: LocaldbDatabase,
  urlValue: string,
  undo?: string,
): Promise<Outcome> {
  const db = database.name;
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: urlValue };
  for (const name of database.env ?? []) env[name] = urlValue;
  const began = Date.now();
  const r = await (ctx.exec ?? realExec)("sh", ["-c", database.migrate!], {
    cwd: ctx.root,
    env,
    echo: true,
    timeoutMs: 600_000,
  });
  const took = formatDuration(Date.now() - began);
  if (r.code === 0) {
    say(ctx, "ok", db, `migrated in ${took} (${database.migrate})`);
    return "ok";
  }
  const why = r.timedOut ? "timed out after 10m" : `exit ${r.code}`;
  say(
    ctx,
    "failed",
    db,
    `migrate ${why} after ${took}${undo ? ` — to go back: pnpm db:local restore ${undo} ${db} --force` : ""}`,
  );
  return "failed";
}

export async function migrate(ctx: Ctx, database: LocaldbDatabase): Promise<Outcome> {
  const db = database.name;
  if (!database.migrate) {
    say(
      ctx,
      "failed",
      db,
      "no migrate command declared — add `migrate` to its entry in sdlc.config.json localdb.databases",
    );
    return "failed";
  }
  const r = await runningUrl(ctx.root, db);
  if (r.state !== "running") {
    say(
      ctx,
      r.state === "stopped" ? "failed" : "could-not-ask",
      db,
      `${r.reason} — pnpm db:local start ${db}`,
    );
    return r.state === "stopped" ? "failed" : "could-not-ask";
  }
  const label = autoLabel("migrate");
  const snap = await snapshot(ctx, database, label);
  if (snap !== "ok") {
    say(ctx, snap, db, "not migrating without the snapshot to go back to");
    return snap;
  }
  prune(ctx, db, dbPaths(ctx.root, db));
  return runMigrate(ctx, database, r.url, label);
}

export async function reset(
  ctx: Ctx,
  database: LocaldbDatabase,
  opts: { force?: boolean } = {},
): Promise<Outcome> {
  const db = database.name;
  const paths = dbPaths(ctx.root, db);
  const settled = settle(ctx, db, paths, readLock(paths));
  if (settled === "held") return "could-not-ask";
  if (settled === "running") {
    if (!opts.force) {
      say(
        ctx,
        "failed",
        db,
        `running — reset deletes its data. pnpm db:local stop ${db} first, or pass --force`,
      );
      return "failed";
    }
    if ((await stop(ctx, database)) !== "ok") return "failed";
  }
  if (existsSync(paths.data)) {
    // Reset is the one command that destroys data, so it keeps a way back.
    const kept = await snapshot(ctx, database, autoLabel("reset"));
    if (kept !== "ok") {
      say(ctx, kept, db, "not resetting without the snapshot to go back to");
      return kept;
    }
    prune(ctx, db, paths);
    if (!claim(paths, "busy", "reset")) {
      say(ctx, "could-not-ask", db, "another process took the lock just now; try again");
      return "could-not-ask";
    }
    rmSync(paths.data, { recursive: true, force: true });
    release(paths);
    say(ctx, "ok", db, "data deleted");
  }
  const started = await start(ctx, database, { hint: false });
  if (started !== "ok") return started;
  if (!database.migrate) {
    say(ctx, "info", db, "n/a  no migrate command declared; the database is empty");
    return "ok";
  }
  const r = await runningUrl(ctx.root, db);
  if (r.state !== "running") {
    say(ctx, "could-not-ask", db, r.reason);
    return "could-not-ask";
  }
  return runMigrate(ctx, database, r.url);
}

export function snapshots(ctx: Ctx, database: LocaldbDatabase): Outcome {
  const db = database.name;
  const list = listSnapshots(dbPaths(ctx.root, db));
  if (!list.length) {
    say(ctx, "ok", db, "no snapshots");
    return "ok";
  }
  say(
    ctx,
    "ok",
    db,
    `${list.length} snapshot(s), newest first (automatic ones: newest kept, rest pruned)`,
  );
  for (const s of list)
    ctx.log(
      `        ${s.label.padEnd(36)} ${formatBytes(s.bytes).padStart(9)}  ${new Date(s.mtimeMs).toISOString()}  ${s.auto ? "auto" : "manual"}`,
    );
  return "ok";
}
