import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { portSlot, portsForSlot } from "./ports.mts";
import type { PortHolder } from "./ports.mts";
import type { HostAnswer } from "./ownership.mts";
import type { StackStamp } from "./stamp.mts";
import { freeStackPorts, resetStack, resolveStackUrls } from "./urls.mts";

/** A directory that is a checkout: it carries the marker. */
const checkout = (marker = "pnpm-workspace.yaml") => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "journeys-urls-")));
  writeFileSync(join(dir, marker), "");
  return dir;
};
const free = (): PortHolder => ({ kind: "free" });

describe("resolveStackUrls", () => {
  it("derives the pair from the checkout, and pins it into the environment", () => {
    const dir = checkout();
    const env: NodeJS.ProcessEnv = {};
    const urls = resolveStackUrls({ cwd: join(dir), env, classify: free });
    expect({ app: urls.appPort, db: urls.dbPort }).toEqual(portsForSlot(portSlot(dir)));
    // Load-bearing: a second resolver in a spawned process must inherit this
    // answer rather than probe again and possibly get another.
    expect(env.JOURNEY_APP_PORT).toBe(String(urls.appPort));
    expect(env.JOURNEY_DB_PORT).toBe(String(urls.dbPort));
  });

  it("lets an explicit variable win", () => {
    const env: NodeJS.ProcessEnv = { JOURNEY_APP_PORT: "4100", JOURNEY_DB_PORT: "6600" };
    const urls = resolveStackUrls({ cwd: checkout(), env, classify: free });
    expect(urls).toMatchObject({
      appPort: 4100,
      dbPort: 6600,
      controlPort: 6601,
      appUrl: "http://localhost:4100",
      controlUrl: "http://127.0.0.1:6601",
    });
  });

  it("refuses a variable that is not a port", () => {
    const env: NodeJS.ProcessEnv = { JOURNEY_APP_PORT: "nope", JOURNEY_DB_PORT: "6600" };
    expect(() => resolveStackUrls({ cwd: checkout(), env, classify: free })).toThrow(/JOURNEY-004/);
  });

  /**
   * Anchored on the checkout, not on the working directory, so a driver spawned
   * from a subdirectory writes where the runner reads.
   */
  it("anchors the outbox and object store on the checkout, under scratch", () => {
    const dir = checkout();
    const urls = resolveStackUrls({
      cwd: join(dir),
      env: {},
      classify: free,
      scratchRoot: "tmp/e2e",
    });
    expect(urls.outboxDir).toBe(join(dir, "tmp/e2e", "email-outbox"));
    expect(urls.objectDir).toBe(join(dir, "tmp/e2e", "object-store"));
  });

  it("finds the checkout by a configured marker and band", () => {
    const dir = checkout("deno.json");
    const ports = { appBase: 4000, dbBase: 7000, slots: 8, marker: "deno.json" };
    const urls = resolveStackUrls({ cwd: dir, env: {}, classify: free, ports });
    expect(urls.checkout).toBe(dir);
    expect(urls.appPort).toBe(4000 + portSlot(dir, 8));
    expect(urls.dbPort).toBe(7000 + portSlot(dir, 8) * 2);
  });

  it("gives two checkouts two different pairs", () => {
    // Hash slots can collide (four checkouts over 128 slots, about one in
    // twenty), so the claim is about *these* two paths — asserted on paths whose
    // slots differ, which is what a collision-free pair looks like.
    const a = "/work/main";
    const b = "/work/main/.claude/worktrees/feature";
    expect(portSlot(a)).not.toBe(portSlot(b));
    expect(portsForSlot(portSlot(a))).not.toEqual(portsForSlot(portSlot(b)));
  });
});

describe("resetStack", () => {
  it("posts to /reset and accepts a 200", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return new Response("reset\n", { status: 200 });
    }) as typeof fetch;
    await resetStack("http://127.0.0.1:9", fake);
    expect(calls).toEqual(["POST http://127.0.0.1:9/reset"]);
  });

  /** A reset that quietly did nothing is the flake it exists to remove, reported as success. */
  it("throws when the host refuses", async () => {
    const fake = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(resetStack("http://127.0.0.1:9", fake)).rejects.toThrow(/JOURNEY-001.*500/);
  });

  it("throws when nothing answers", async () => {
    const fake = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(resetStack("http://127.0.0.1:9", fake)).rejects.toThrow(/JOURNEY-001/);
  });
});

/**
 * **The sweep, which is the only code here that sends `SIGKILL`** (#598,
 * #613, #1416). The assertion that matters on every refusal is that
 * nothing was killed, which is why `kill` is a seam of its own.
 */
describe("freeStackPorts", () => {
  const urls = { appPort: 3101, dbPort: 5502, checkout: "/repo" };
  const holders =
    (byPort: Record<number, PortHolder>) =>
    (port: number): PortHolder =>
      byPort[port] ?? { kind: "free" };

  /** What a host stamped when it was ready: itself, and every listener on its ports. */
  const stamp: StackStamp = {
    name: "fixture",
    devOverlayPossible: false,
    pid: 100,
    nonce: "n0nce",
    controlUrl: "http://127.0.0.1:5503",
    owned: [
      { pid: 100, port: 5503, started: "Fri Oct 16 10:00:00 2026" },
      { pid: 101, port: 5502, started: "Fri Oct 16 10:00:01 2026" },
      { pid: 102, port: 3101, started: "Fri Oct 16 10:00:02 2026" },
      { pid: 103, port: 3101, started: "Fri Oct 16 10:00:03 2026" },
    ],
  };
  const startedAsRecorded = (pid: number) =>
    stamp.owned!.find((o) => o.pid === pid)?.started ?? "Sat Oct 17 09:00:00 2026";
  const gone = (): HostAnswer => ({ kind: "refused" });
  const abandoned = { readStamp: () => stamp, ask: gone, startedOf: startedAsRecorded };

  it("kills the listeners an abandoned stack of this checkout recorded, and only those", () => {
    const kill = vi.fn();
    freeStackPorts(urls, {
      env: {},
      classify: holders({
        5502: { kind: "ours", pids: [101] },
        3101: { kind: "ours", pids: [102, 103] },
      }),
      kill,
      log: () => {},
      ...abandoned,
    });
    expect(kill.mock.calls).toEqual([
      [101, "SIGKILL"],
      [102, "SIGKILL"],
      [103, "SIGKILL"],
    ]);
  });

  it("refuses to kill a live journey run of this checkout (JOURNEY-005)", () => {
    const kill = vi.fn();
    expect(() =>
      freeStackPorts(urls, {
        env: {},
        classify: holders({ 3101: { kind: "ours", pids: [102] } }),
        kill,
        ...abandoned,
        ask: () => ({ kind: "answered", pid: 100, nonce: "n0nce" }),
      }),
    ).toThrow(/JOURNEY-005.*live journey run/s);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses when anything else answers the stamped control channel: a newer run still starting", () => {
    const kill = vi.fn();
    expect(() =>
      freeStackPorts(urls, {
        env: {},
        classify: holders({ 3101: { kind: "ours", pids: [102] } }),
        kill,
        ...abandoned,
        ask: () => ({ kind: "answered" }),
      }),
    ).toThrow(/JOURNEY-005/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses a listener of this checkout that no stack stamped: a dev server (JOURNEY-006)", () => {
    const kill = vi.fn();
    expect(() =>
      freeStackPorts(urls, {
        env: {},
        classify: holders({ 3101: { kind: "ours", pids: [4242] } }),
        kill,
        readStamp: () => null,
        ask: gone,
        startedOf: startedAsRecorded,
      }),
    ).toThrow(/JOURNEY-006.*4242.*no journey stack/s);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses a listener the abandoned stack did not record", () => {
    const kill = vi.fn();
    expect(() =>
      freeStackPorts(urls, {
        env: {},
        classify: holders({ 3101: { kind: "ours", pids: [4242] } }),
        kill,
        ...abandoned,
      }),
    ).toThrow(/JOURNEY-006.*did not record it/s);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses a recorded pid that has since been reused, or whose start cannot be read", () => {
    for (const startedOf of [() => "Sat Oct 17 09:00:00 2026", () => null]) {
      const kill = vi.fn();
      expect(() =>
        freeStackPorts(urls, {
          env: {},
          classify: holders({ 3101: { kind: "ours", pids: [102] } }),
          kill,
          ...abandoned,
          startedOf,
        }),
      ).toThrow(/JOURNEY-006/);
      expect(kill).not.toHaveBeenCalled();
    }
  });

  it("refuses when whether the stack is alive could not be asked (JOURNEY-007)", () => {
    const kill = vi.fn();
    expect(() =>
      freeStackPorts(urls, {
        env: {},
        classify: holders({ 3101: { kind: "ours", pids: [102] } }),
        kill,
        ...abandoned,
        ask: () => ({ kind: "unreachable", why: "TimeoutError" }),
      }),
    ).toThrow(/JOURNEY-007/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("judges every port before it kills any", () => {
    const kill = vi.fn();
    expect(() =>
      freeStackPorts(urls, {
        env: {},
        // 5502 is a recorded orphan; 3101 is a stranger. Neither dies.
        classify: holders({
          5502: { kind: "ours", pids: [101] },
          3101: { kind: "ours", pids: [4242] },
        }),
        kill,
        ...abandoned,
      }),
    ).toThrow(/JOURNEY-006/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses another checkout's live process, and names it", () => {
    const kill = vi.fn();
    expect(() =>
      freeStackPorts(urls, {
        env: {},
        classify: holders({
          3101: { kind: "theirs", pids: [4321], checkout: "/repo/.claude/worktrees/somebody" },
        }),
        kill,
      }),
    ).toThrow(/JOURNEY-002.*somebody/s);
    expect(kill).not.toHaveBeenCalled();
  });

  it("refuses a holder it cannot attribute, rather than guessing", () => {
    const kill = vi.fn();
    expect(() =>
      freeStackPorts(urls, {
        env: {},
        classify: holders({ 3101: { kind: "unknown", pids: [999] } }),
        kill,
      }),
    ).toThrow(/JOURNEY-003/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("sweeps the control channel beside the database port", () => {
    const kill = vi.fn();
    freeStackPorts(urls, {
      env: {},
      classify: holders({ 5503: { kind: "ours", pids: [100] } }),
      kill,
      log: () => {},
      ...abandoned,
    });
    expect(kill).toHaveBeenCalledWith(100, "SIGKILL");
  });

  it("does nothing inside a Playwright worker", () => {
    const kill = vi.fn();
    const classify = vi.fn(free);
    freeStackPorts(urls, { env: { TEST_WORKER_INDEX: "0" }, classify, kill });
    expect(classify).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("does nothing when somebody else owns the stack", () => {
    const kill = vi.fn();
    const classify = vi.fn(free);
    freeStackPorts(urls, { env: { JOURNEY_DB_EXTERNAL: "1" }, classify, kill });
    expect(classify).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});
