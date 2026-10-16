/**
 * Is a port free? Asked by **binding it**, not by reading `lsof`: a bind is the
 * exact question the server is about to ask, and needs no tool a laptop may lack.
 *
 * Each address is tried, because a listener on ::1 does not hold 127.0.0.1 and a
 * browser resolving `localhost` may reach either.
 *
 * The one error that is not a holder: binding ::1 on a machine with no IPv6 at
 * all fails with EADDRNOTAVAIL (or EAFNOSUPPORT). Nothing can listen on an
 * address the machine does not have, so that address is skipped. Every other
 * failure means held. Shared by tooling/localdb and tooling/journeys so they
 * cannot disagree about the same port.
 */
import { createServer } from "node:net";

export const PROBE_HOSTS: Array<string | undefined> = ["127.0.0.1", "::1", undefined];

export type BindResult = "free" | "held" | "no-such-address";

export function classifyBindError(code: string | undefined, host: string | undefined): BindResult {
  if (host === "::1" && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT")) {
    return "no-such-address";
  }
  return "held";
}

export function bindable(port: number, host: string | undefined): Promise<BindResult> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(classifyBindError(err.code, host)));
    probe.listen(
      host === undefined ? { port, exclusive: true } : { port, host, exclusive: true },
      () => probe.close(() => resolve("free")),
    );
  });
}

export async function portIsFree(port: number): Promise<boolean> {
  for (const host of PROBE_HOSTS) if ((await bindable(port, host)) === "held") return false;
  return true;
}
