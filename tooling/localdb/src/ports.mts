/**
 * Is a port free? Asked by **binding it**, not by reading `lsof`: a bind either
 * succeeds or fails with EADDRINUSE, which is the exact question the server is
 * about to ask, and it needs no tool a laptop may lack (#1293).
 */
import { portIsFree } from "../../core/src/ports.mts";
import { candidatePorts } from "./lib.mts";

export { portIsFree };

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
