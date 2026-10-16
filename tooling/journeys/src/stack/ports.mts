import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

/**
 * Which ports this checkout's journey stack owns — **derived, so nobody has to
 * remember.**
 *
 * `JOURNEY_APP_PORT` and `JOURNEY_DB_PORT` already existed and defaulted to
 * 3000 and 5433, which meant every checkout wanted the same two. The variables
 * were the fix for the collision and they only work if somebody sets them, so
 * in practice four worktrees all ran on 3000 and the first one to start a
 * journey run `SIGKILL`ed the other three's dev servers.
 *
 * Measured 2026-09-05: four live checkouts — the main one plus
 * `five-issues`, `j40` and `tenant-portal` — every one of them defaulting to
 * 3000 and 5433.
 *
 * So the default is now a function of the checkout rather than a constant. An
 * explicitly set variable still wins, and a single-checkout laptop gets a
 * stable pair it can bookmark.
 *
 * ## Two properties this has to have, and they pull against each other
 *
 * **Stable**, because `freeJourneyPorts` sweeps what a *previous run of this
 * checkout* abandoned. Ports that moved between runs would leave every orphan
 * behind, holding a port nothing would ever reclaim.
 *
 * **Distinct**, because that is the whole point. A hash gives stability and
 * only probabilistic distinctness — four checkouts over 128 slots collide about
 * one time in twenty — so a derived port that is *held by somebody else* steps
 * to the next slot. Ours or free, we keep it; anyone else's, we move.
 *
 * That second rule is also what makes the band choice unimportant. A slot that
 * lands on an unrelated service — VNC, a proxy, somebody's Rails app — is
 * stepped over for the same reason and by the same code.
 */

/** Slots in the band. Distinctness is resolved by stepping, so this is a hint. */
export const JOURNEY_PORT_SLOTS = 128;

/** The app under test. Not 3000, which is left for an interactive `pnpm dev`. */
export const JOURNEY_APP_PORT_BASE = 3100;

/** The adapter's database. Two apart, because each run also claims `+1` for its control channel. */
export const JOURNEY_DB_PORT_BASE = 5500;

/** The file whose nearest ancestor directory is "a checkout". */
export const CHECKOUT_MARKER = "pnpm-workspace.yaml";

/**
 * **Where a project's band lives, and what marks a checkout.**
 *
 * The constants above are the defaults; `journeys.config.mts`
 * overrides any of them (`ports` in `config.mts`). Changing a base or the slot
 * count moves every checkout's derived pair at once, which strands whatever a
 * previous run left on the old ones — do it between runs, not during one.
 */
export type PortPlan = {
  appBase: number;
  dbBase: number;
  slots: number;
  /** A file every checkout — main or linked worktree — carries at its root. */
  marker: string;
};

export const DEFAULT_PORT_PLAN: PortPlan = {
  appBase: JOURNEY_APP_PORT_BASE,
  dbBase: JOURNEY_DB_PORT_BASE,
  slots: JOURNEY_PORT_SLOTS,
  marker: CHECKOUT_MARKER,
};

/*
 * **POSIX only, for attribution.** Who holds a port is answered by `lsof`
 * (listeners, and a process's working directory), and the host's tree kill by
 * `pgrep -P`. Both exist on macOS and every mainstream Linux. On a machine
 * without them `listenerPids` returns `[]` — every port reads `free` to
 * `classifyPort` — and `checkoutOfPid` returns null, so a listener it *can* see
 * reads `unknown` and is never killed. Whether a port can be **bound** is
 * Node's own answer (`portIsFree`) and needs no tool at all.
 */

/**
 * The checkout a path belongs to — the main repository or one linked worktree.
 *
 * The nearest ancestor holding the marker (`pnpm-workspace.yaml` by default), which is **not** the same
 * as "starts with the repository root": a worktree lives at
 * `.claude/worktrees/<name>` *inside* the main checkout, so a prefix test
 * claims every worktree's processes as the main checkout's. Nearest-ancestor
 * gets it right in both directions because a worktree carries its own copy of
 * that file.
 *
 * `exists` is a parameter so the walk can be tested without a filesystem.
 */
export function checkoutOf(
  start: string,
  exists: (path: string) => boolean = existsSync,
  marker: string = CHECKOUT_MARKER,
): string | null {
  let dir = resolve(start);
  for (;;) {
    if (exists(resolve(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A checkout's slot in the band. Stable for the life of the path. */
export function portSlot(checkout: string, slots: number = JOURNEY_PORT_SLOTS): number {
  return createHash("sha256").update(checkout).digest().readUInt32BE(0) % slots;
}

/** The pair a slot names. The database port also implies `+1` for its control channel. */
export function portsForSlot(
  slot: number,
  plan: Pick<PortPlan, "appBase" | "dbBase"> = DEFAULT_PORT_PLAN,
): { app: number; db: number } {
  return { app: plan.appBase + slot, db: plan.dbBase + slot * 2 };
}

/**
 * Who holds a port.
 *
 * `unknown` is the third answer and is deliberately not folded into either of
 * the others: a listener whose working directory cannot be read — or can, and
 * lies in no checkout — is neither safe to kill nor safe to share with.
 */
export type PortHolder =
  | { kind: "free" }
  | { kind: "ours"; pids: number[] }
  | { kind: "theirs"; pids: number[]; checkout: string }
  | { kind: "unknown"; pids: number[] };

/**
 * Processes **listening** on a port — not everything connected to it.
 *
 * `lsof -ti :<port>` also lists clients, so sweeping what it prints murders a
 * browser helper alongside the server. `-sTCP:LISTEN` asks the question that
 * was meant.
 */
export function listenerPids(port: number): number[] {
  const out =
    spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .stdout ?? "";
  return out
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter(Boolean);
}

/** The checkout a running process belongs to, via its working directory. */
export function checkoutOfPid(pid: number, marker: string = CHECKOUT_MARKER): string | null {
  const out =
    spawnSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8" }).stdout ??
    "";
  const cwd = out
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return cwd ? checkoutOf(cwd, existsSync, marker) : null;
}

/**
 * Classify a port against the checkout asking.
 *
 * Both probes are parameters so the decision can be tested without opening a
 * socket — the branch that matters is the one that decides whether to send
 * `SIGKILL`, and it should not need a victim to exercise.
 */
export function classifyPort(
  port: number,
  ours: string,
  probe: (port: number) => number[] = listenerPids,
  owner: (pid: number) => string | null = checkoutOfPid,
): PortHolder {
  const pids = probe(port);
  if (pids.length === 0) return { kind: "free" };

  // Not `pids.map(owner)`: map passes the index as a second argument, which
  // `checkoutOfPid` reads as its marker — the real sweep threw on every held port.
  const owners = pids.map((pid) => owner(pid));
  if (owners.every((checkout) => checkout === ours)) return { kind: "ours", pids };

  const theirs = owners.find((checkout) => checkout !== null && checkout !== ours);
  return theirs ? { kind: "theirs", pids, checkout: theirs } : { kind: "unknown", pids };
}

/**
 * The ports this run should use.
 *
 * Steps to the next slot while the derived pair is held by somebody else, so a
 * hash collision or a well-known port in the band costs a slot rather than
 * another agent's dev server. Sixteen tries and then it gives up and returns
 * the derived pair, because refusing to run is a worse answer than trying and
 * reporting `EADDRINUSE`.
 */
export function resolveJourneyPorts(
  checkout: string,
  classify: (port: number, ours: string) => PortHolder = classifyPort,
  plan: PortPlan = DEFAULT_PORT_PLAN,
): { app: number; db: number; slot: number; steps: number } {
  const first = portSlot(checkout, plan.slots);
  for (let steps = 0; steps < 16; steps++) {
    const slot = (first + steps) % plan.slots;
    const { app, db } = portsForSlot(slot, plan);
    const held = [app, db, db + 1].map((port) => classify(port, checkout));
    if (held.every((holder) => holder.kind === "free" || holder.kind === "ours")) {
      return { app, db, slot, steps };
    }
  }
  const { app, db } = portsForSlot(first, plan);
  return { app, db, slot: first, steps: 16 };
}

/**
 * The addresses a probe has to try, because **no one of them sees the others**.
 *
 * Measured 2026-09-23, macOS 25.1 / Node 24, one holder at a time on a free
 * port:
 *
 * | holder | `127.0.0.1` probe | wildcard probe | `::1` probe |
 * | --- | --- | --- | --- |
 * | `127.0.0.1` | EADDRINUSE | **free** | free |
 * | wildcard | **free** | EADDRINUSE | free |
 * | `::1` | free | free | EADDRINUSE |
 *
 * Every off-diagonal cell is a way to be wrong, and two of them were: the
 * first version of this probe bound the wildcard alone, on the reasoning that
 * it is what `next dev` binds and that a dual-stack wildcard would therefore
 * cover a loopback listener. The table's first row says it does not — so the
 * probe called a port free, and `PGLiteSocketServer`, which binds `127.0.0.1`
 * explicitly, then failed on it (#1295). Reversing it to the loopback alone
 * would have been the second row: blind to `next dev`'s own wildcard.
 *
 * So all three, and a port is free only when every one of them binds. That is
 * deliberately stricter than *the server we are about to start could bind
 * this*: `localhost` resolves to `127.0.0.1` or `::1` depending on the
 * client, so a listener on either is one a browser may reach **instead of
 * ours** — which is the failure `agents.md` records against port 3000, where
 * a readiness probe passed against another agent's server. Over-stepping
 * costs a port number; under-stepping costs an afternoon.
 */
// One answer for the whole repo: tooling/core/src/ports.mts.
import { portIsFree } from "../../../core/src/ports.mts";
export { portIsFree };

/** `theirs` names the checkout; the rest say what can be said. */
export function describeHolder(holder: PortHolder): string {
  switch (holder.kind) {
    case "free":
      return "something lsof cannot see";
    case "ours":
      return "this checkout";
    case "theirs":
      return holder.checkout;
    case "unknown":
      return `pid ${holder.pids.join(", ")}`;
  }
}

export type PortResolution =
  | { kind: "ok"; port: number; skipped: { port: number; holder: PortHolder }[] }
  | { kind: "held"; port: number; holder: PortHolder }
  | { kind: "none"; from: number; tried: number };

/** The first port of `width` from `port` that cannot be bound, or null. */
async function firstHeld(
  port: number,
  width: number,
  free: (port: number) => Promise<boolean>,
): Promise<number | null> {
  for (let i = 0; i < width; i++) if (!(await free(port + i))) return port + i;
  return null;
}

/**
 * The port a long-lived server should take — asked **before** anything else
 * starts, so a held port costs a probe rather than the two minutes of seeding
 * that precede the bind (#1293).
 *
 * Two answers on a held port, split by whether somebody chose it:
 *
 * | | |
 * | --- | --- |
 * | the default | **step** to the next free port and say what was skipped and who held it |
 * | an explicit port | **refuse**, naming the holder. A port somebody typed is a decision, and moving off it silently is a confident wrong answer — the server would come up somewhere they are not looking |
 *
 * Unlike the journey slots, *ours* is not kept: a listener of this checkout's
 * own is a live server somebody is using, not an orphan to sweep.
 *
 * **`width` and `step` are how one call answers for a pair** (#1295). A
 * database slot is two ports — the socket server and the control channel
 * beside it — so it is probed two wide and stepped two at a time, which lands
 * on the next *slot* rather than inside this one. The port reported as held is
 * the one that actually refused the bind, so a free database port whose
 * control channel is taken names the control channel.
 */
export async function resolvePort(
  preferred: number,
  {
    explicit,
    ours,
    step = 1,
    width = 1,
    free = portIsFree,
    classify = classifyPort,
  }: {
    explicit: boolean;
    ours: string;
    step?: number;
    width?: number;
    free?: (port: number) => Promise<boolean>;
    classify?: (port: number, ours: string) => PortHolder;
  },
): Promise<PortResolution> {
  const held = await firstHeld(preferred, width, free);
  if (held === null) return { kind: "ok", port: preferred, skipped: [] };
  if (explicit) return { kind: "held", port: held, holder: classify(held, ours) };

  const skipped: { port: number; holder: PortHolder }[] = [
    { port: held, holder: classify(held, ours) },
  ];
  for (let n = 1; n < 16; n++) {
    const port = preferred + n * step;
    const blocked = await firstHeld(port, width, free);
    if (blocked === null) return { kind: "ok", port, skipped };
    skipped.push({ port: blocked, holder: classify(blocked, ours) });
  }
  return { kind: "none", from: preferred, tried: 16 };
}

/** One port, stepping by one. */
export const resolveAppPort = (
  preferred: number,
  explicit: boolean,
  ours: string,
  free?: (port: number) => Promise<boolean>,
  classify?: (port: number, ours: string) => PortHolder,
): Promise<PortResolution> => resolvePort(preferred, { explicit, ours, free, classify });

/**
 * A database slot: the socket server and the control channel beside it, so the
 * pair is probed together and a step lands on the next slot.
 */
export const resolveDbPort = (
  preferred: number,
  explicit: boolean,
  ours: string,
  free?: (port: number) => Promise<boolean>,
  classify?: (port: number, ours: string) => PortHolder,
): Promise<PortResolution> =>
  resolvePort(preferred, { explicit, ours, step: 2, width: 2, free, classify });
