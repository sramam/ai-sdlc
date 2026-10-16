/**
 * `db:local stop` signals a pid only when it can prove whose it is, and a
 * failed start never leaves its server running. Each case stages the situation
 * against real processes: a reused pid, another checkout's live server, a `ps`
 * that cannot answer, a readiness probe that fails after the lock was written.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dbPaths } from "./lib.mts";
import type { Lock } from "./lib.mts";
import * as ops from "./localdb.mts";
import type { Ctx, ProcessInfo } from "./localdb.mts";

const db = { name: "main" };
const roots: string[] = [];
const children: ChildProcess[] = [];

function checkout(): { root: string; ctx: Ctx; lines: string[] } {
  const root = mkdtempSync(join(tmpdir(), "localdb-stop-"));
  roots.push(root);
  const lines: string[] = [];
  return { root, lines, ctx: { root, log: (l) => lines.push(l) } };
}

/** A live process that is not a localdb server, though its command line says `server.mts`. */
function impostor(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "server.mts"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function writeLock(root: string, lock: Partial<Lock>): void {
  mkdirSync(dbPaths(root, "main").dir, { recursive: true });
  writeFileSync(
    dbPaths(root, "main").lock,
    JSON.stringify({
      state: "ready",
      url: "postgresql://x",
      startedAt: new Date().toISOString(),
      ...lock,
    }),
  );
}

/** A control port nothing listens on: bind and release one. */
async function deadPort(): Promise<number> {
  const { createServer } = await import("node:net");
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const cannotAsk = (): ProcessInfo | null => null;

afterAll(async () => {
  for (const c of children) c.kill("SIGKILL");
  for (const root of roots) {
    await ops.stop({ root, log: () => {} }, db).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

describe("db:local stop, proving identity before it signals", { timeout: 60_000 }, () => {
  it("stops a running server over its control channel, even where ps cannot answer", async () => {
    const { root, ctx } = checkout();
    expect(await ops.start(ctx, db)).toBe("ok");
    const pid = (JSON.parse(readFileSync(dbPaths(root, "main").lock, "utf8")) as Lock).pid;
    expect(await ops.stop({ ...ctx, identify: cannotAsk }, db)).toBe("ok");
    expect(ops.isAlive(pid)).toBe(false);
    expect(existsSync(dbPaths(root, "main").lock)).toBe(false);
  });

  it("signals nothing and keeps the lock when the control channel is gone and ps cannot answer", async () => {
    const { root, ctx, lines } = checkout();
    const victim = impostor();
    writeLock(root, {
      pid: victim.pid!,
      port: 55_999,
      control: { port: await deadPort(), token: "t" },
    });
    expect(await ops.stop({ ...ctx, identify: cannotAsk }, db)).toBe("could-not-ask");
    expect(ops.isAlive(victim.pid!)).toBe(true);
    expect(existsSync(dbPaths(root, "main").lock)).toBe(true);
    expect(lines.at(-1)).toMatch(/nothing was signalled/);
  });

  it("clears the lock of a reused pid without signalling the program that has it now", async () => {
    const { root, ctx, lines } = checkout();
    const victim = impostor(); // its command line contains "server.mts"
    writeLock(root, {
      pid: victim.pid!,
      port: 55_999,
      control: { port: await deadPort(), token: "t" },
    });
    expect(await ops.stop(ctx, db)).toBe("ok");
    expect(ops.isAlive(victim.pid!)).toBe(true);
    expect(existsSync(dbPaths(root, "main").lock)).toBe(false);
    expect(lines.at(-1)).toMatch(/belongs to another program/);
  });

  it("never stops another checkout's live server named by a stale lock", async () => {
    const other = checkout();
    expect(await ops.start(other.ctx, db)).toBe("ok");
    const theirs = JSON.parse(readFileSync(dbPaths(other.root, "main").lock, "utf8")) as Lock;

    const mine = checkout();
    // Their pid and control port, but not their token: what a lock copied between
    // checkouts, or a pid reused by their server, looks like.
    writeLock(mine.root, {
      pid: theirs.pid,
      port: theirs.port!,
      control: { port: theirs.control!.port, token: "not-theirs" },
    });
    expect(await ops.stop(mine.ctx, db)).toBe("ok");
    expect(ops.isAlive(theirs.pid)).toBe(true);
    expect(await ops.runningUrl(other.root, "main")).toMatchObject({ state: "running" });
    expect(await ops.stop(other.ctx, db)).toBe("ok");
  });
});

describe("judgeServer", () => {
  const paths = dbPaths("/repo", "main");
  const lock: Lock = {
    pid: 1,
    state: "ready",
    port: 55_001,
    startedAt: "2026-10-16T10:00:05.000Z",
  };
  const server = join(import.meta.dirname, "server.mts");
  const cmd = (data = paths.data, port = 55_001) =>
    `/usr/bin/node ${server} --name main --data ${data} --snapshots ${paths.snapshots} --lock ${paths.lock} --port ${port}`;
  const at = (iso: string | null) => (iso ? new Date(iso) : null);

  it("is ours only on the exact command line and a start before the lock", () => {
    expect(
      ops.judgeServer({ command: cmd(), started: at("2026-10-16T10:00:03Z") }, paths, lock),
    ).toBe("ours");
    expect(ops.judgeServer({ command: cmd(), started: null }, paths, lock)).toBe("ours");
  });
  it("is unsure when the process started after the lock was written: a reused pid", () => {
    expect(
      ops.judgeServer({ command: cmd(), started: at("2026-10-16T11:00:00Z") }, paths, lock),
    ).toBe("unsure");
  });
  it("is not ours when it serves some other data directory", () => {
    expect(
      ops.judgeServer(
        { command: cmd("/elsewhere/.localdb/main/data"), started: null },
        paths,
        lock,
      ),
    ).toBe("not-ours");
    expect(ops.judgeServer({ command: "node -e x server.mts", started: null }, paths, lock)).toBe(
      "not-ours",
    );
  });
  it("is unsure when it names our data directory in any other shape", () => {
    expect(ops.judgeServer({ command: cmd(paths.data, 55_002), started: null }, paths, lock)).toBe(
      "unsure",
    );
  });
});

describe(
  "db:local start, when the server reports ready and does not answer",
  { timeout: 60_000 },
  () => {
    it("stops the exact child it spawned and removes the lock that names it", async () => {
      const { root, ctx, lines } = checkout();
      expect(await ops.start({ ...ctx, answers: async () => false }, db)).toBe("failed");
      const pid = Number(/server pid (\d+) reported ready/.exec(lines.join("\n"))?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(ops.isAlive(pid)).toBe(false);
      expect(existsSync(dbPaths(root, "main").lock)).toBe(false);
      expect(lines.at(-1)).toMatch(/stopped pid/);
    });
  },
);
