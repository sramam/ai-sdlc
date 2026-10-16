/**
 * Where this checkout's journey stack lives — **one definition, several processes.**
 *
 * The generic half of door_nexa's `journey-db-url.ts`. The runner, every test
 * worker, the stack host and anything they spawn must agree on the app's port,
 * the control channel, and where captured mail and stored objects go: a worker
 * looking at a different outbox than the app wrote to finds nothing, and reports
 * a broken sign-in rather than a misconfigured path.
 *
 * **No database URL.** door_nexa built a Postgres URL here, with a connection
 * bound whose history is the cautionary tale of #916. Which database, which
 * driver and what URL shape are the adapter's business — this module hands an
 * adapter a `dbPort` and stops there.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PORT_PLAN,
  checkoutOf,
  checkoutOfPid,
  classifyPort,
  listenerPids,
  resolveJourneyPorts,
} from "./ports.mts";
import type { PortHolder, PortPlan } from "./ports.mts";
import { askHost, judgeOwnership, processStarted, recordedBy } from "./ownership.mts";
import type { HostAnswer, Ownership } from "./ownership.mts";
import { UNKNOWN_STACK, readStackStamp } from "./stamp.mts";
import type { StackStamp } from "./stamp.mts";

/** The variables that pin a run's ports. Set either to move this run out of the way. */
export const APP_PORT_VAR = "JOURNEY_APP_PORT";
export const DB_PORT_VAR = "JOURNEY_DB_PORT";
/** Set when somebody else owns the stack — the learner reusing one host across passes. */
export const EXTERNAL_VAR = "JOURNEY_DB_EXTERNAL";
/** Playwright's own marker, set only inside a worker. */
export const WORKER_VAR = "TEST_WORKER_INDEX";

export type StackUrls = {
  /** This checkout — the main repository, or the linked worktree we are inside. */
  checkout: string;
  appPort: number;
  dbPort: number;
  /** The host's control channel: the database port's `+1`, in one place. */
  controlPort: number;
  /** `localhost`, because that is what a browser and the app's own origin check use. */
  appUrl: string;
  /** Loopback by address: the control server binds `127.0.0.1` and nothing else. */
  controlUrl: string;
  /** Captured mail. Under scratch, so the next stack's sweep throws it away. */
  outboxDir: string;
  /** The local object store. Under scratch for the same reason. */
  objectDir: string;
};

export type ResolveOptions = {
  cwd?: string;
  /** Read for explicit ports and **written back** — see below. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  ports?: PortPlan;
  scratchRoot?: string;
  /** Who holds a port; the real one asks `lsof`. A parameter so a test needs no victim. */
  classify?: (port: number, ours: string) => PortHolder;
};

/**
 * **Derived per checkout, and pinned into the environment.**
 *
 * An explicitly set `JOURNEY_APP_PORT` / `JOURNEY_DB_PORT` wins; otherwise the
 * pair comes from the checkout's path (`resolveJourneyPorts`), stepping past a
 * slot somebody else holds.
 *
 * **Written back into `env`, which is load-bearing.** door_nexa imported this in
 * the runner, again inside every Playwright worker and again in the stack
 * process; re-deriving in each would be a second answer to one question, and a
 * probe is allowed to come back differently a second later. Pinning it means
 * the first resolver in the process tree decides and everything spawned after
 * it inherits the answer.
 */
export function resolveStackUrls({
  cwd = process.cwd(),
  env = process.env,
  ports = DEFAULT_PORT_PLAN,
  scratchRoot = "test-results",
  classify,
}: ResolveOptions = {}): StackUrls {
  const checkout = checkoutOf(cwd, existsSync, ports.marker) ?? cwd;
  const owner = (pid: number) => checkoutOfPid(pid, ports.marker);
  const realClassify = (port: number, ours: string) =>
    classifyPort(port, ours, listenerPids, owner);

  const app = env[APP_PORT_VAR];
  const db = env[DB_PORT_VAR];
  let appPort: number;
  let dbPort: number;
  if (app && db) {
    appPort = Number(app);
    dbPort = Number(db);
  } else {
    const derived = resolveJourneyPorts(checkout, classify ?? realClassify, ports);
    appPort = app ? Number(app) : derived.app;
    dbPort = db ? Number(db) : derived.db;
  }
  for (const [name, port] of [
    [APP_PORT_VAR, appPort],
    [DB_PORT_VAR, dbPort],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`JOURNEY-004: ${name}=${env[name]} is not a port`);
    }
  }

  env[APP_PORT_VAR] = String(appPort);
  env[DB_PORT_VAR] = String(dbPort);

  return {
    checkout,
    appPort,
    dbPort,
    controlPort: dbPort + 1,
    appUrl: `http://localhost:${appPort}`,
    controlUrl: `http://127.0.0.1:${dbPort + 1}`,
    /*
     * Anchored on the checkout rather than `process.cwd()`, so a driver spawned
     * from anywhere resolves the place the runner reads. door_nexa met the other
     * version: a worktree's `.env.local` pointed the outbox at the main checkout,
     * the drivers wrote there, the test read here, and the assertion reported
     * `121 is not 122`.
     */
    outboxDir: join(checkout, scratchRoot, "email-outbox"),
    objectDir: join(checkout, scratchRoot, "object-store"),
  };
}

/**
 * **Back to the seeded state, between journeys** — `POST /reset` on the host.
 *
 * Per file rather than per test in door_nexa, because a per-test reset runs
 * after that test's fixtures and deletes what they built.
 *
 * **It throws rather than warning.** A reset that quietly did nothing leaves the
 * previous journey's state in place, which is the flake it exists to remove,
 * reported as success — the *could-not-ask* answer collapsed into *yes*.
 */
export async function resetStack(
  controlUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const answer = await fetchImpl(`${controlUrl}/reset`, { method: "POST" }).catch(
    (cause: unknown) => {
      throw new Error(
        `JOURNEY-001: the stack host did not answer at ${controlUrl}/reset, so this file would run on the previous journey's state`,
        { cause },
      );
    },
  );
  if (!answer.ok) {
    throw new Error(
      `JOURNEY-001: the stack host refused to reset (${answer.status} from ${controlUrl}/reset), so this file would run on the previous journey's state`,
    );
  }
}

/**
 * **Take the ports, rather than assume they are free — and take only our own.**
 *
 * A run that ends badly leaves the app and the database holding their ports,
 * and the next run dies with `EADDRINUSE`. Teardown cannot cover the cases that
 * need it most, because whatever killed the run killed the teardown too.
 *
 * ## A sweep is for what a **previous run of this checkout** abandoned
 *
 * This sends `SIGKILL`, and in a second worktree the thing on the port is
 * another agent's server — killed with no message, while this run's app falls
 * back a port and passes its readiness probe against the survivor (door_nexa
 * #598). So every listener is attributed to a checkout first, and only ours is
 * killed. Another checkout's stops the run (`JOURNEY-002`); one whose working
 * directory cannot be read stops it too (`JOURNEY-003`) — neither safe to kill
 * nor safe to share with.
 *
 * ## And this checkout's own listener is killed only when it is provably abandoned
 *
 * Being *this checkout's* is not being an orphan. A second journey run here,
 * or a dev server that sits on a derived port, has the same working directory
 * as an orphan and is alive and wanted. So a listener of ours is killed only
 * when the last stack this checkout stamped (`stack.json` in scratch) does not
 * answer its control channel, **and** recorded that exact listener — pid and
 * start time — while it was alive (`ownership.mts`):
 *
 * | | |
 * | --- | --- |
 * | the stamped host answers `/whoami` (or anything answers there) | `JOURNEY-005`: a live run owns it |
 * | the listener is not one the abandoned stack recorded, or its start time differs or cannot be read | `JOURNEY-006`: named, left alone |
 * | the host could not be asked (a timeout) | `JOURNEY-007`: could not ask, so nothing is killed |
 *
 * Every holder of every port is judged before anything is signalled, so a
 * refusal on the third port does not follow a kill on the first.
 *
 * `kill` is separate from `classify` so a refusal can be asserted to have killed
 * nothing, which is the only assertion about a refusal worth making.
 */
export function freeStackPorts(
  urls: Pick<StackUrls, "appPort" | "dbPort" | "checkout">,
  {
    env = process.env,
    marker = DEFAULT_PORT_PLAN.marker,
    classify = (port: number, ours: string) =>
      classifyPort(port, ours, listenerPids, (pid) => checkoutOfPid(pid, marker)),
    kill = process.kill,
    log = (line: string) => console.warn(line),
    scratchDir = join(urls.checkout, "test-results"),
    readStamp = () => {
      const stamp = readStackStamp(scratchDir);
      return stamp === UNKNOWN_STACK ? null : stamp;
    },
    ask = askHost,
    startedOf = processStarted,
  }: {
    env?: NodeJS.ProcessEnv;
    /** The file that marks a checkout (`ports.marker` in the journeys config). */
    marker?: string;
    classify?: (port: number, ours: string) => PortHolder;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    log?: (line: string) => void;
    /** Where this checkout's stack stamp lives: `<root>/<scratchRoot>`. */
    scratchDir?: string;
    readStamp?: () => StackStamp | null;
    ask?: (controlUrl: string) => HostAnswer;
    startedOf?: (pid: number) => string | null;
  } = {},
): void {
  // A Playwright config is re-loaded in every worker; a worker sweeping after
  // the app took its port killed the run. A cleanup at the wrong moment is
  // indistinguishable from sabotage.
  if (env[WORKER_VAR] !== undefined) return;
  // Somebody else owns the stack — the one case where the thing on the port is
  // alive and wanted. door_nexa's sweep once ignored this and killed the stack
  // the learner had started thirty seconds earlier.
  if (env[EXTERNAL_VAR]) return;

  const move = `  Set ${APP_PORT_VAR} and ${DB_PORT_VAR} to move this run out of the way.`;
  let ownership: Ownership | undefined;
  const condemned: Array<{ port: number; pid: number }> = [];

  // The control channel too: an orphan holding `+1` fails the next run as surely.
  for (const port of [urls.dbPort, urls.dbPort + 1, urls.appPort]) {
    const holder = classify(port, urls.checkout);
    if (holder.kind === "free") continue;

    if (holder.kind === "theirs") {
      throw new Error(
        `JOURNEY-002: port ${port} is held by ${holder.checkout} (pid ${holder.pids.join(", ")}), ` +
          `which is a different checkout — refusing to kill it.\n` +
          `  Ports are derived from the checkout path, so this is a hash collision or a port taken since.\n` +
          move,
      );
    }
    if (holder.kind === "unknown") {
      throw new Error(
        `JOURNEY-003: port ${port} is held by pid ${holder.pids.join(", ")}, whose checkout could not be read ` +
          `— refusing to kill what cannot be attributed.\n` +
          move,
      );
    }

    ownership ??= judgeOwnership(readStamp(), ask);
    if (ownership.kind === "live") {
      throw new Error(
        `JOURNEY-005: port ${port} (pid ${holder.pids.join(", ")}) belongs to a live journey run in this checkout — ` +
          `${ownership.who} answered its control channel. Refusing to kill it.\n` +
          `  Wait for that run to finish, or run alongside it:\n` +
          move,
      );
    }
    if (ownership.kind === "could-not-ask") {
      throw new Error(
        `JOURNEY-007: port ${port} is held by pid ${holder.pids.join(", ")} of this checkout, and whether the stack ` +
          `that owns it is still alive could not be asked — ${ownership.why}. Refusing to kill it.\n` +
          move,
      );
    }
    for (const pid of holder.pids) {
      const verdict =
        ownership.kind === "abandoned"
          ? recordedBy(ownership.stamp, pid, startedOf)
          : { kill: false as const, why: "no journey stack of this checkout stamped it" };
      if (!verdict.kill) {
        throw new Error(
          `JOURNEY-006: port ${port} is held by pid ${pid}, a process of this checkout, and ${verdict.why} — ` +
            `so it is not provably an orphan of a journey run (a dev server, say, or a run killed before it ` +
            `was ready). Refusing to kill it. Stop it yourself if it is an orphan:\n` +
            `    kill ${pid}\n` +
            move,
        );
      }
      condemned.push({ port, pid });
    }
  }

  for (const { port, pid } of condemned) {
    try {
      kill(pid, "SIGKILL");
      log(
        `journeys: freed port ${port} (killed ${pid}, recorded by an abandoned journey stack here)`,
      );
    } catch {
      // Gone between the listing and the kill, which is the outcome wanted.
    }
  }
}
