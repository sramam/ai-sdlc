import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  JOURNEY_PORT_SLOTS,
  checkoutOf,
  classifyPort,
  portSlot,
  portsForSlot,
  portIsFree,
  resolveAppPort,
  resolveDbPort,
  resolveJourneyPorts,
  type PortHolder,
} from "./ports.mts";

/**
 * A filesystem where only the named directories hold a `pnpm-workspace.yaml`.
 *
 * The main checkout and a worktree *inside* it, which is the arrangement the
 * prefix test got wrong.
 */
const MAIN = "/repo";
const WORKTREE = "/repo/.claude/worktrees/j40";
const workspaces = (path: string) =>
  path === `${MAIN}/pnpm-workspace.yaml` || path === `${WORKTREE}/pnpm-workspace.yaml`;

describe("checkoutOf", () => {
  it("finds the checkout a path is in", () => {
    expect(checkoutOf(`${MAIN}/apps/web`, workspaces)).toBe(MAIN);
  });

  /**
   * **The one that a prefix test gets wrong.** A worktree lives inside the main
   * checkout, so `cwd.startsWith(main)` claims every worktree's processes as
   * the main checkout's — and the sweep then kills them.
   */
  it("attributes a worktree to itself, not to the repository containing it", () => {
    expect(checkoutOf(`${WORKTREE}/apps/web`, workspaces)).toBe(WORKTREE);
    expect(checkoutOf(WORKTREE, workspaces)).toBe(WORKTREE);
  });

  it("returns null outside any checkout", () => {
    expect(checkoutOf("/tmp/somewhere", workspaces)).toBeNull();
  });
});

describe("portSlot", () => {
  it("is stable for a path", () => {
    expect(portSlot(MAIN)).toBe(portSlot(MAIN));
  });

  it("separates two checkouts", () => {
    expect(portSlot(MAIN)).not.toBe(portSlot(WORKTREE));
  });

  it("stays inside the band", () => {
    for (const path of [MAIN, WORKTREE, "/a", "/b/c/d"]) {
      expect(portSlot(path)).toBeGreaterThanOrEqual(0);
      expect(portSlot(path)).toBeLessThan(JOURNEY_PORT_SLOTS);
    }
  });

  /**
   * The database port claims `+1` for its control channel, so two adjacent
   * slots must not overlap. One slot's `db + 1` is the next slot's `db - 1`.
   */
  it("leaves the control channel room", () => {
    const here = portsForSlot(4);
    const next = portsForSlot(5);
    expect(next.db).toBeGreaterThan(here.db + 1);
  });
});

describe("classifyPort", () => {
  const ours = MAIN;
  const holder = (pids: number[], owner: (pid: number) => string | null) =>
    classifyPort(3100, ours, () => pids, owner);

  it("reports a port nobody listens on as free", () => {
    expect(holder([], () => null)).toEqual({ kind: "free" });
  });

  it("reports our own listener as ours", () => {
    expect(holder([11], () => MAIN)).toEqual({ kind: "ours", pids: [11] });
  });

  it("reports another checkout's listener as theirs, and names it", () => {
    expect(holder([12], () => WORKTREE)).toEqual({
      kind: "theirs",
      pids: [12],
      checkout: WORKTREE,
    });
  });

  /**
   * An unattributable listener is the third answer. Reporting it as `free`
   * would `EADDRINUSE`; reporting it as `ours` would kill a stranger.
   */
  it("reports a listener it cannot attribute as unknown", () => {
    expect(holder([13], () => null)).toEqual({ kind: "unknown", pids: [13] });
  });

  it("does not call a mixed set ours", () => {
    expect(holder([14, 15], (pid) => (pid === 14 ? MAIN : WORKTREE)).kind).toBe("theirs");
  });
});

describe("resolveJourneyPorts", () => {
  const free = (): PortHolder => ({ kind: "free" });

  it("takes its own slot when nothing is in the way", () => {
    const { app, db, steps } = resolveJourneyPorts(MAIN, free);
    expect(steps).toBe(0);
    expect({ app, db }).toEqual(portsForSlot(portSlot(MAIN)));
  });

  /** Our own orphan is what the sweep exists to kill — so we keep the slot. */
  it("keeps a slot our own abandoned run is holding", () => {
    const { steps } = resolveJourneyPorts(MAIN, () => ({ kind: "ours", pids: [1] }));
    expect(steps).toBe(0);
  });

  it("steps past a slot another checkout holds", () => {
    const taken = portsForSlot(portSlot(MAIN));
    const { app, db, steps } = resolveJourneyPorts(MAIN, (port) =>
      port === taken.app ? { kind: "theirs", pids: [1], checkout: WORKTREE } : { kind: "free" },
    );
    expect(steps).toBe(1);
    expect(app).not.toBe(taken.app);
    expect(db).not.toBe(taken.db);
  });

  it("steps past a slot an unrelated service holds", () => {
    const taken = portsForSlot(portSlot(MAIN));
    const { steps } = resolveJourneyPorts(MAIN, (port) =>
      port === taken.db ? { kind: "unknown", pids: [1] } : { kind: "free" },
    );
    expect(steps).toBe(1);
  });

  /**
   * **Gives up rather than refusing to run.** Sixteen occupied slots is not a
   * state worth a bespoke error; `EADDRINUSE` from the thing that actually
   * binds says the same and says it at the right moment.
   */
  it("returns the derived pair when everything is held", () => {
    const { steps, app } = resolveJourneyPorts(MAIN, () => ({ kind: "unknown", pids: [1] }));
    expect(steps).toBe(16);
    expect(app).toBe(portsForSlot(portSlot(MAIN)).app);
  });
});

describe("resolveAppPort", () => {
  const busy = new Set<number>();
  const free = async (port: number) => !busy.has(port);
  const theirs = (port: number): PortHolder =>
    busy.has(port) ? { kind: "theirs", pids: [7], checkout: WORKTREE } : { kind: "free" };

  it("takes the preferred port when it is free", async () => {
    busy.clear();
    expect(await resolveAppPort(3000, false, MAIN, free, theirs)).toEqual({
      kind: "ok",
      port: 3000,
      skipped: [],
    });
  });

  /** The default steps, and says what it stepped over and who held it. */
  it("steps past held ports and names each holder", async () => {
    busy.clear();
    busy.add(3000);
    busy.add(3001);
    const r = await resolveAppPort(3000, false, MAIN, free, theirs);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.port).toBe(3002);
    expect(r.skipped.map((s) => s.port)).toEqual([3000, 3001]);
    expect(r.skipped[0]!.holder).toEqual({ kind: "theirs", pids: [7], checkout: WORKTREE });
  });

  /**
   * A port somebody typed is refused rather than moved off — the server would
   * otherwise come up where they are not looking.
   */
  it("refuses an explicit port that is held, naming the holder", async () => {
    busy.clear();
    busy.add(3010);
    expect(await resolveAppPort(3010, true, MAIN, free, theirs)).toEqual({
      kind: "held",
      port: 3010,
      holder: { kind: "theirs", pids: [7], checkout: WORKTREE },
    });
  });

  /** Our own live server is not an orphan to keep — it is stepped over too. */
  it("does not reuse a port this checkout's own server holds", async () => {
    busy.clear();
    busy.add(3000);
    const r = await resolveAppPort(3000, false, MAIN, free, () => ({ kind: "ours", pids: [1] }));
    expect(r.kind === "ok" && r.port).toBe(3001);
  });

  it("gives up after sixteen rather than scanning the machine", async () => {
    busy.clear();
    for (let p = 3000; p < 3100; p++) busy.add(p);
    expect(await resolveAppPort(3000, false, MAIN, free, theirs)).toEqual({
      kind: "none",
      from: 3000,
      tried: 16,
    });
  });
});

describe("resolveDbPort", () => {
  const busy = new Set<number>();
  const free = async (port: number) => !busy.has(port);
  const theirs = (port: number): PortHolder =>
    busy.has(port) ? { kind: "theirs", pids: [9], checkout: WORKTREE } : { kind: "free" };

  it("takes the slot when both of its ports are free", async () => {
    busy.clear();
    const r = await resolveDbPort(5530, false, MAIN, free, theirs);
    expect(r).toEqual({ kind: "ok", port: 5530, skipped: [] });
  });

  /**
   * The control channel is the half a single-port probe misses: the database
   * port binds, the server comes up, and `journey-db`'s control socket then
   * fails on a port somebody else has.
   */
  it("steps a slot whose control channel is held, and names that port", async () => {
    busy.clear();
    busy.add(5531);
    const r = await resolveDbPort(5530, false, MAIN, free, theirs);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.port).toBe(5532);
    expect(r.skipped).toEqual([
      { port: 5531, holder: { kind: "theirs", pids: [9], checkout: WORKTREE } },
    ]);
  });

  /** Two at a time, so a step lands on the next slot rather than inside this one. */
  it("steps by a whole slot", async () => {
    busy.clear();
    busy.add(5530);
    busy.add(5532);
    const r = await resolveDbPort(5530, false, MAIN, free, theirs);
    expect(r.kind === "ok" && r.port).toBe(5534);
  });

  it("refuses an explicit slot that is held", async () => {
    busy.clear();
    busy.add(5530);
    expect(await resolveDbPort(5530, true, MAIN, free, theirs)).toEqual({
      kind: "held",
      port: 5530,
      holder: { kind: "theirs", pids: [9], checkout: WORKTREE },
    });
  });

  /** A second playground in one checkout: the holder is us, and it still steps. */
  it("does not reuse a slot this checkout's own playground holds", async () => {
    busy.clear();
    busy.add(5530);
    const r = await resolveDbPort(5530, false, MAIN, free, () => ({ kind: "ours", pids: [1] }));
    expect(r.kind === "ok" && r.port).toBe(5532);
  });
});

/**
 * **The probe itself, against a real listener on each address.**
 *
 * The cases above inject `free`, so they exercise the stepping and not the
 * thing that decides it — and that is where it went wrong: a wildcard-only
 * probe reported a port free while `PGLiteSocketServer` held `127.0.0.1` on
 * it, and every injected test stayed green (#1295). This one holds the port
 * for real, which is the only way that asymmetry is visible.
 */
describe("portIsFree", () => {
  /** A listener on `host`, or null where the platform has no such address. */
  const hold = (host: string | undefined) =>
    new Promise<{ port: number; close: () => Promise<void> } | null>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(null));
      server.listen(host === undefined ? { port: 0 } : { port: 0, host }, () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          port,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    });

  it("sees a holder on the loopback, on ::1, and on the wildcard", async () => {
    let asserted = 0;
    for (const host of ["127.0.0.1", "::1", undefined]) {
      const held = await hold(host);
      // A machine with no IPv6 cannot hold `::1`, and then there is nothing to
      // assert rather than something to fail.
      if (held === null) continue;
      expect(await portIsFree(held.port), `held on ${host ?? "the wildcard"}`).toBe(false);
      await held.close();
      asserted++;
    }
    expect(asserted, "no address could be held at all — the case is vacuous").toBeGreaterThan(0);
  });

  it("reports a port nobody holds as free", async () => {
    const held = await hold("127.0.0.1");
    expect(held).not.toBeNull();
    const port = held!.port;
    await held!.close();
    expect(await portIsFree(port)).toBe(true);
  });
});
