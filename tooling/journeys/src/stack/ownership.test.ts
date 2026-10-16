/**
 * The sweep against real processes: listeners spawned in a throwaway checkout,
 * attributed by the real `lsof`, asked by the real `/whoami` probe, and dated
 * by the real `ps`. The unit cases in `urls.test.ts` pin each branch; these
 * prove the instruments answer the way those branches assume.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { askHost, judgeOwnership, processStarted } from "./ownership.mts";
import { listenerPids } from "./ports.mts";
import { writeStackStamp } from "./stamp.mts";
import { freeStackPorts } from "./urls.mts";

const dirs: string[] = [];
const children: ChildProcess[] = [];

function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "journeys-own-")));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "");
  dirs.push(dir);
  return dir;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/**
 * A process in `cwd` listening on a port of its own choosing (port 0, so no
 * other test file can take it first), answering `/whoami` with `nonce` when
 * given one.
 */
async function listener(
  cwd: string,
  nonce?: string,
): Promise<{ child: ChildProcess; port: number }> {
  const code = `
    const http = require("node:http");
    const nonce = ${JSON.stringify(nonce ?? null)};
    const s = http.createServer((q, r) => {
      if (q.url === "/whoami" && nonce !== null) return r.end(JSON.stringify({ pid: process.pid, nonce }));
      r.writeHead(404).end();
    });
    s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;
  const child = spawn(process.execPath, ["-e", code], {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.once("data", (d: Buffer) => resolve(Number(String(d).trim())));
    child.once("exit", (c) => reject(new Error(`listener exited ${c}`)));
  });
  return { child, port };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("telling a live journey run from an abandoned one", { timeout: 30_000 }, () => {
  it("reads a process's start time, and nothing for a pid that is gone", () => {
    expect(processStarted(process.pid)).toMatch(/\d{4}$/);
    expect(processStarted(2 ** 22 + 12_345)).toBeNull();
  });

  it("asks a host who it is, and hears nothing from a closed port", async () => {
    const { child: host, port } = await listener(checkout(), "abc");
    expect(askHost(`http://127.0.0.1:${port}`)).toEqual({
      kind: "answered",
      pid: host.pid,
      nonce: "abc",
    });
    expect(askHost(`http://127.0.0.1:${await freePort()}`)).toEqual({ kind: "refused" });
  });

  it("refuses to kill a live run of this checkout, which answers with its stamped nonce", async () => {
    const dir = checkout();
    const { child: app, port: appPort } = await listener(dir);
    const { child: host, port: controlPort } = await listener(dir, "live-nonce");
    const controlUrl = `http://127.0.0.1:${controlPort}`;
    const stamp = {
      name: "fixture",
      devOverlayPossible: false,
      pid: host.pid!,
      nonce: "live-nonce",
      controlUrl,
    };
    writeStackStamp(join(dir, "test-results"), { ...stamp, owned: [] });
    expect(judgeOwnership(stamp).kind).toBe("live");
    const dbPort = await freePort();
    expect(() =>
      freeStackPorts(
        { appPort, dbPort, checkout: dir },
        { env: {}, scratchDir: join(dir, "test-results") },
      ),
    ).toThrow(/JOURNEY-005/);
    expect(alive(app.pid!)).toBe(true);
  });

  it("refuses a dev server in this checkout that no journey stack stamped", async () => {
    const dir = checkout();
    const { child: dev, port: appPort } = await listener(dir);
    const dbPort = await freePort();
    expect(() =>
      freeStackPorts(
        { appPort, dbPort, checkout: dir },
        { env: {}, scratchDir: join(dir, "test-results") },
      ),
    ).toThrow(/JOURNEY-006/);
    expect(alive(dev.pid!)).toBe(true);
  });

  it("kills the listener an abandoned stack recorded, once its host no longer answers", async () => {
    const dir = checkout();
    const { child: orphan, port: appPort } = await listener(dir);
    const [pid] = listenerPids(appPort);
    expect(pid).toBe(orphan.pid);
    writeStackStamp(join(dir, "test-results"), {
      name: "fixture",
      devOverlayPossible: false,
      pid: 999_999,
      nonce: "gone",
      controlUrl: `http://127.0.0.1:${await freePort()}`,
      owned: [{ pid: pid!, port: appPort, started: processStarted(pid!)! }],
    });
    const exited = new Promise((r) => orphan.once("exit", r));
    freeStackPorts(
      { appPort, dbPort: await freePort(), checkout: dir },
      { env: {}, scratchDir: join(dir, "test-results"), log: () => {} },
    );
    await exited;
    expect(alive(pid!)).toBe(false);
  });
});
