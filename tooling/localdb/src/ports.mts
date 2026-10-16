/**
 * Is a port free? Asked by **binding it**, not by reading `lsof`: a bind either
 * succeeds or fails with EADDRINUSE, which is the exact question the server is
 * about to ask, and it needs no tool a laptop may lack (door_nexa #1293).
 */
import { createServer } from "node:net";
import { candidatePorts } from "./lib.mts";

/** Each host is tried, because a listener on ::1 does not hold 127.0.0.1 and vice versa. */
const PROBE_HOSTS: Array<string | undefined> = ["127.0.0.1", "::1", undefined];

function bindable(port: number, host: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      // A host with no IPv6 at all says EADDRNOTAVAIL for ::1. That is not a
      // holder, and refusing every port on such a machine would be wrong.
      resolve(err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT");
    });
    probe.listen(
      host === undefined ? { port, exclusive: true } : { port, host, exclusive: true },
      () => probe.close(() => resolve(true)),
    );
  });
}

export async function portIsFree(port: number): Promise<boolean> {
  for (const host of PROBE_HOSTS) if (!(await bindable(port, host))) return false;
  return true;
}

export interface PortChoice {
  port: number;
  /** Ports skipped because somebody held them, in order. */
  held: number[];
}

/** The first free candidate, or null when every one is held. */
export async function choosePort(
  checkout: string,
  db: string,
  isFree: (port: number) => Promise<boolean> = portIsFree,
): Promise<PortChoice | null> {
  const held: number[] = [];
  for (const port of candidatePorts(checkout, db)) {
    if (await isFree(port)) return { port, held };
    held.push(port);
  }
  return null;
}
