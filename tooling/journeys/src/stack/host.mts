/**
 * **The stack host: one process that owns the app under test for a run.**
 *
 * The generic half of door_nexa's `journey-db.mts`. That script built the app,
 * started PGlite behind a socket, seeded it, spawned `next start`, served a
 * control channel, and tore it all down — and every part that named Next, PGlite
 * or Prisma was a decision about door_nexa rather than about recording. Those
 * moved behind a `StackAdapter`; what stayed here is what any app needs:
 *
 * | | |
 * | --- | --- |
 * | **build, with one retry** | a build cannot hide a regression the way a retried test can — it produces correct output or none — and door_nexa's `next build` failed intermittently on identical source (#1465) |
 * | **sweep scratch, once, here** | never in test setup: the learner starts one stack and runs the suite more than once, and a sweep between passes deletes the mail pass 2 is diffed against (#1068) |
 * | **a control channel** | `POST /reset` puts the state back between journey files without restarting anything, which is what stopped three passes fighting over ports |
 * | **teardown that finishes** | the app tree first, leaves first, SIGTERM then SIGKILL after a grace period; once, however many signals arrive |
 *
 * ## What an adapter must do that this cannot check
 *
 * **Spawn children in this process's group — never `detached: true`.** door_nexa
 * once detached the app "so the whole tree dies", and it was the cause of the
 * fault it meant to prevent: Playwright group-kills the host on teardown with no
 * chance to run a handler, a child in the same group dies with it, and a detached
 * child is reparented to PID 1 and keeps the port — and the inherited stdout, so
 * the invoking shell waits for ever on a stream nobody will close ("the suite
 * takes 31 minutes"). Return the root child's `pid` so the graceful path can
 * kill the tree explicitly; the group kill covers the ungraceful one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { WHOAMI_PATH } from "./ownership.mts";
import { sweepScratch } from "./scratch.mts";
import type { StackUrls } from "./urls.mts";

/** What an adapter is handed. Everything here was derived once, in `urls.mts`. */
export type StackEnv = {
  checkout: string;
  appPort: number;
  /** The adapter's database, if it has one. Its `+1` is the host's control channel. */
  dbPort: number;
  appUrl: string;
  /** Where captured mail goes, if the app sends any. */
  outboxDir: string;
  /** Where a local object store keeps files, if the app stores any. */
  objectDir: string;
};

/**
 * Which build of the app a recording runs against — a **declaration**, because
 * nothing can derive it (door_nexa #1484). The recorder reads
 * `devOverlayPossible` to decide whether a framework dev overlay could be in a
 * screenshot at all; door_nexa records against `next start` precisely so that
 * it cannot.
 */
export type StackMode = { name: string; devOverlayPossible: boolean };

export type StackHandle = {
  /** Release whatever `start` acquired, after the app tree is dead. */
  stop(): Promise<void>;
  /**
   * The root process of the app, if `start` spawned one. The host kills its
   * tree (`pgrep -P`, leaves first) before calling `stop`. An addition to the
   * minimal contract: without it the host cannot do the one part of teardown
   * door_nexa found it could not leave to the child.
   */
  pid?: number;
};

export interface StackAdapter {
  name: string;
  /** Produce what `start` serves. Retried once; a second failure stops the run. */
  build?(): Promise<void>;
  start(env: StackEnv): Promise<StackHandle>;
  /** Back to an empty, migrated state. The host seeds after it. */
  reset(): Promise<void>;
  /** A path on the app that answers below 400 once it is ready to be recorded. */
  readyPath: string;
  mode: StackMode;
}

export interface SeedAdapter {
  /** Build the state every journey starts from, on top of a fresh `reset`. */
  seed(): Promise<void>;
}

export type HostOptions = {
  adapter: StackAdapter;
  seed?: SeedAdapter;
  urls: StackUrls;
  scratchRoot?: string;
  scratchKeep?: readonly string[];
  /** How long the app may take to answer `readyPath`. */
  readyTimeoutMs?: number;
  /** How long the app tree gets between SIGTERM and SIGKILL. door_nexa: 2s. */
  killGraceMs?: number;
  /**
   * A random value this host answers `GET /whoami` with, beside its pid. The
   * stamp records it, so a later sweep can tell this host — alive — from one
   * that merely left a stamp behind (`ownership.mts`).
   */
  nonce?: string;
  log?: (line: string) => void;
};

export type Host = {
  urls: StackUrls;
  mode: StackMode;
  /** Idempotent: every call after the first returns the first call's promise. */
  stop(): Promise<void>;
};

/** Children of a process, by `pgrep -P`. POSIX; `[]` where pgrep is absent. */
export function childPids(pid: number): number[] {
  const out = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter(Boolean);
}

/**
 * Kill a process and everything under it, **leaves first**.
 *
 * `pnpm` spawns `next`, which spawns `next-server`; killing only the top leaves
 * the server holding the port. `pgrep -P` rather than a group kill, because the
 * app deliberately shares the host's group — a group kill here would take the
 * host before it could finish tearing down.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals,
  children: (pid: number) => number[] = childPids,
): void {
  for (const child of children(pid)) killTree(child, signal, children);
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, which is the outcome wanted.
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Poll `url` until it answers below 400, or throw `JOURNEY-012`.
 *
 * `redirect: "manual"`, so an app that sends an anonymous visitor to a sign-in
 * page counts as up — the redirect is the app answering.
 */
export async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      if (answer.status < 400) return;
      last = `HTTP ${answer.status}`;
    } catch (error) {
      last = String((error as { cause?: { code?: string } }).cause?.code ?? error);
    }
    await sleep(100);
  }
  throw new Error(`JOURNEY-012: ${url} was not ready within ${timeoutMs}ms (last: ${last})`);
}

/** Build, retrying once. Throws `JOURNEY-010` after the second failure. */
async function buildWithRetry(adapter: StackAdapter, log: (line: string) => void): Promise<void> {
  if (!adapter.build) return;
  try {
    await adapter.build();
    return;
  } catch (first) {
    log(
      `journeys: ${adapter.name} did not build (${String(first)}). Retrying once — a build ` +
        "cannot hide a regression the way a retried test can, and a really broken one fails again.",
    );
  }
  try {
    await adapter.build();
  } catch (second) {
    throw new Error(
      `JOURNEY-010: ${adapter.name} did not build, twice, so there is nothing to record ` +
        "against. Nothing was started and no recording was touched.",
      { cause: second },
    );
  }
}

/**
 * Start the stack, and return once the app is ready to be recorded.
 *
 * If anything after `adapter.start` fails, what was started is torn down before
 * the error propagates — a half-started stack holding ports is the orphan the
 * next run's sweep has to clean up.
 */
export async function startHost({
  adapter,
  seed,
  urls,
  scratchRoot = "test-results",
  scratchKeep,
  readyTimeoutMs = 120_000,
  killGraceMs = 2_000,
  nonce,
  log = (line: string) => console.warn(line),
}: HostOptions): Promise<Host> {
  const t0 = Date.now();
  const say = (what: string) =>
    log(`journeys[${adapter.name}]: ${what} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  await buildWithRetry(adapter, log);

  const swept = sweepScratch(urls.checkout, {
    scratchRoot,
    ...(scratchKeep ? { keep: scratchKeep } : {}),
  });
  if (swept.length > 0) say(`cleared ${scratchRoot}/{${swept.join(", ")}}`);
  mkdirSync(urls.outboxDir, { recursive: true });
  mkdirSync(urls.objectDir, { recursive: true });

  const handle = await adapter.start({
    checkout: urls.checkout,
    appPort: urls.appPort,
    dbPort: urls.dbPort,
    appUrl: urls.appUrl,
    outboxDir: urls.outboxDir,
    objectDir: urls.objectDir,
  });
  say(`started (${adapter.mode.name})`);

  let control: Server | undefined;
  let stopping: Promise<void> | undefined;

  const teardown = async () => {
    const pid = handle.pid;
    if (pid !== undefined) {
      killTree(pid, "SIGTERM");
      say(`asked the app tree (${pid}) to stop`);
      // Escalate rather than trust: a survivor holds the port, and costs the
      // next run an afternoon.
      for (let waited = 0; waited < killGraceMs && alive(pid); waited += 100) await sleep(100);
      if (alive(pid)) {
        killTree(pid, "SIGKILL");
        /*
         * Wait for it to be gone, not merely signalled: a child of this process
         * answers `kill(pid, 0)` until it is reaped, and returning first hands
         * the next step a port that is still held for a moment.
         */
        for (let waited = 0; waited < 1_000 && alive(pid); waited += 20) await sleep(20);
        say(`app tree ${pid} ignored SIGTERM for ${killGraceMs}ms — killed`);
      } else say("app tree stopped");
    }
    await handle.stop();
    say("adapter stopped");
    if (control) {
      const server = control;
      await new Promise<void>((done) => server.close(() => done()));
      say("control channel closed — teardown complete");
    }
  };
  /*
   * Once, however many signals arrive: a second teardown racing the first is how
   * a group kill lands after the exit rather than before it.
   */
  const stop = () => (stopping ??= teardown());

  /*
   * Resets are serialised: two files resetting at once would interleave a
   * reset with a seed and hand one of them a half-built state.
   */
  let queue: Promise<void> = Promise.resolve();
  const resetAndSeed = () => {
    const next = queue.then(async () => {
      await adapter.reset();
      await seed?.seed();
    });
    queue = next.catch(() => {});
    return next;
  };

  try {
    await resetAndSeed();
    say(seed ? "reset and seeded" : "reset (no seed adapter)");

    control = createServer((request, response) => {
      if (request.method === "GET" && request.url === WHOAMI_PATH && nonce !== undefined) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ pid: process.pid, nonce }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/reset") {
        // Any answer proves the host is listening — `probe.mts` reads a 404
        // to a liveness GET as "up", deliberately.
        response.writeHead(404).end();
        return;
      }
      resetAndSeed().then(
        () => {
          say("reset to seeded state");
          response.writeHead(200).end("reset\n");
        },
        (error: unknown) => response.writeHead(500).end(String(error)),
      );
    });
    const server = control;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(urls.controlPort, "127.0.0.1", () => resolve());
    });
    say(`control on ${urls.controlPort}`);

    await waitForReady(`${urls.appUrl}${adapter.readyPath}`, readyTimeoutMs);
    say(`ready at ${urls.appUrl}${adapter.readyPath}`);
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }

  return { urls, mode: adapter.mode, stop };
}

/**
 * Stop the host on SIGINT/SIGTERM and exit — the shape door_nexa's script had,
 * for a host run as Playwright's `webServer` command.
 */
export function stopOnSignals(host: Host, exit: (code: number) => void = process.exit): void {
  const quit = () => void host.stop().then(() => exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
