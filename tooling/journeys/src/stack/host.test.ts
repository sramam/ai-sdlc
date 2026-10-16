import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childPids, startHost } from "./host.mts";
import type { Host, SeedAdapter, StackAdapter, StackEnv } from "./host.mts";
import { portIsFree, portSlot, portsForSlot } from "./ports.mts";
import { resolveStackUrls } from "./urls.mts";

/**
 * **The host, driven end to end against a fake adapter.**
 *
 * No database and no framework — an adapter that serves one page from a child
 * `node` process, which itself spawns a grandchild. That is the shape that
 * matters: door_nexa's app was `pnpm → next → next-server`, and the fault worth
 * proving absent is a grandchild surviving teardown and holding a port.
 *
 * POSIX: teardown and attribution use `pgrep` and `lsof`, as the host does.
 */

const work = realpathSync(mkdtempSync(join(tmpdir(), "journeys-host-")));

/** The fake app: serve `readyPath`, spawn a grandchild, optionally ignore SIGTERM. */
const APP = join(work, "fake-app.mjs");
writeFileSync(
  APP,
  `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const [port, readyPath, stubborn] = process.argv.slice(2);
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (stubborn === "1") process.on("SIGTERM", () => {});
createServer((req, res) => {
  res.writeHead(req.url === readyPath ? 200 : 404).end("fake app");
}).listen(Number(port));
`,
);

/** A directory that is a checkout, with stale scratch in it. */
function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(work, "checkout-")));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "");
  mkdirSync(join(dir, "test-results", "stale-outbox"), { recursive: true });
  mkdirSync(join(dir, "test-results", "playwright"), { recursive: true });
  return dir;
}

/** A free port whose `+1` is also free — a database slot and its control channel. */
async function freePair(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port: p } = s.address() as AddressInfo;
        s.close(() => resolve(p));
      });
    });
    if (port < 65000 && (await portIsFree(port)) && (await portIsFree(port + 1))) return port;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Calls = string[];

function fakeAdapter(calls: Calls, opts: { stubborn?: boolean; buildFailures?: number } = {}) {
  let failures = opts.buildFailures ?? 0;
  const state: { pid?: number; stopped: boolean } = { stopped: false };
  const adapter: StackAdapter = {
    name: "fake",
    readyPath: "/ready",
    mode: { name: "fake-prod", devOverlayPossible: false },
    async build() {
      calls.push("build");
      if (failures-- > 0) throw new Error("flaky build");
    },
    async start(env: StackEnv) {
      calls.push(`start ${env.appPort}`);
      const child = spawn(
        process.execPath,
        [APP, String(env.appPort), "/ready", opts.stubborn ? "1" : "0"],
        // Not detached: the adapter contract — see host.mts.
        { stdio: "ignore" },
      );
      state.pid = child.pid;
      return {
        pid: child.pid,
        stop: async () => {
          calls.push("adapter.stop");
          state.stopped = true;
        },
      };
    },
    async reset() {
      calls.push("reset");
    },
  };
  const seed: SeedAdapter = {
    async seed() {
      calls.push("seed");
    },
  };
  return { adapter, seed, state };
}

async function urlsFor(dir: string) {
  const db = await freePair();
  // The app must not land on the control channel, which is free until the host
  // binds it — the first version of this test raced exactly that and probed the
  // control server for readiness, getting its 404 for ever.
  let app = await freePair();
  while (app === db || app === db + 1) app = await freePair();
  return resolveStackUrls({
    cwd: dir,
    env: { JOURNEY_APP_PORT: String(app), JOURNEY_DB_PORT: String(db) },
  });
}

let running: Host | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe("the stack host", { timeout: 30_000 }, () => {
  it("starts, answers ready, resets then seeds on POST /reset, and tears the tree down", async () => {
    const dir = checkout();
    const calls: Calls = [];
    const { adapter, seed, state } = fakeAdapter(calls);
    const urls = await urlsFor(dir);
    const host = (running = await startHost({ adapter, seed, urls, log: () => {} }));

    // Scratch swept at start, Playwright's own kept.
    expect(existsSync(join(dir, "test-results", "stale-outbox"))).toBe(false);
    expect(existsSync(join(dir, "test-results", "playwright"))).toBe(true);
    expect(existsSync(urls.outboxDir)).toBe(true);

    // Ready, and the initial state built: reset before seed.
    expect((await fetch(`${urls.appUrl}/ready`)).status).toBe(200);
    expect(calls).toEqual(["build", `start ${urls.appPort}`, "reset", "seed"]);

    // The control channel.
    const reset = await fetch(`${urls.controlUrl}/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect(calls.slice(-2)).toEqual(["reset", "seed"]);
    expect((await fetch(`${urls.controlUrl}/`)).status).toBe(404);

    // A grandchild exists — the shape that survives a naive kill.
    const pid = state.pid!;
    const grandchildren = childPids(pid);
    expect(grandchildren.length).toBeGreaterThan(0);

    const first = host.stop();
    expect(host.stop()).toBe(first); // once, however many signals arrive
    await first;
    running = undefined;

    expect(alive(pid)).toBe(false);
    for (const g of grandchildren) expect(alive(g), `grandchild ${g}`).toBe(false);
    expect(state.stopped).toBe(true);
    expect(calls.at(-1)).toBe("adapter.stop");
    await expect(fetch(`${urls.controlUrl}/`)).rejects.toThrow();
  });

  it("escalates to SIGKILL when the app ignores SIGTERM", async () => {
    const calls: Calls = [];
    const { adapter, seed, state } = fakeAdapter(calls, { stubborn: true });
    const lines: string[] = [];
    const urls = await urlsFor(checkout());
    const host = (running = await startHost({
      adapter,
      seed,
      urls,
      killGraceMs: 300,
      log: (l) => lines.push(l),
    }));
    await host.stop();
    running = undefined;
    expect(alive(state.pid!)).toBe(false);
    expect(lines.some((l) => l.includes("ignored SIGTERM"))).toBe(true);
  });

  it("retries a failed build once", async () => {
    const calls: Calls = [];
    const { adapter, seed } = fakeAdapter(calls, { buildFailures: 1 });
    running = await startHost({ adapter, seed, urls: await urlsFor(checkout()), log: () => {} });
    expect(calls.slice(0, 3)).toEqual(["build", "build", `start ${running.urls.appPort}`]);
  });

  it("starts nothing when the build fails twice", async () => {
    const calls: Calls = [];
    const { adapter, seed } = fakeAdapter(calls, { buildFailures: 2 });
    await expect(
      startHost({ adapter, seed, urls: await urlsFor(checkout()), log: () => {} }),
    ).rejects.toThrow(/JOURNEY-010/);
    expect(calls).toEqual(["build", "build"]);
  });

  it("tears down what it started when the app never becomes ready", async () => {
    const calls: Calls = [];
    const { adapter, seed, state } = fakeAdapter(calls);
    const broken = { ...adapter, readyPath: "/never" };
    await expect(
      startHost({
        adapter: broken,
        seed,
        urls: await urlsFor(checkout()),
        readyTimeoutMs: 1_000,
        log: () => {},
      }),
    ).rejects.toThrow(/JOURNEY-012/);
    expect(alive(state.pid!)).toBe(false);
    expect(state.stopped).toBe(true);
  });
});

/**
 * **Derived ports, against real listeners.** Attribution reads `lsof`, so this
 * holds a port from this process — whose checkout is the repository the suite
 * runs in — and asks on behalf of a *different* checkout, which must step.
 */
describe("derived ports on a real machine", () => {
  it("gives two checkouts different pairs", () => {
    const a = checkout();
    const b = checkout();
    // Distinct by hash, so assert on the slots: equal slots would be a hash
    // collision, which the next test shows is stepped over rather than shared.
    if (portSlot(a) === portSlot(b)) return;
    const ua = resolveStackUrls({ cwd: a, env: {} });
    const ub = resolveStackUrls({ cwd: b, env: {} });
    expect(ua.appPort).not.toBe(ub.appPort);
    expect(ua.dbPort).not.toBe(ub.dbPort);
  });

  it("steps past a derived port another checkout holds", async () => {
    const dir = checkout();
    const derived = portsForSlot(portSlot(dir));
    const holder = createServer();
    const held = await new Promise<boolean>((resolve) => {
      holder.once("error", () => resolve(false));
      holder.listen(derived.app, () => resolve(true));
    });
    // Somebody else already has it: still a held port, still must step.
    try {
      const urls = resolveStackUrls({ cwd: dir, env: {} });
      expect(urls.appPort).not.toBe(derived.app);
    } finally {
      if (held) await new Promise<void>((done) => holder.close(() => done()));
    }
  });
});
