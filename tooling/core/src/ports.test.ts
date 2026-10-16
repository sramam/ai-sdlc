import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { classifyBindError, portIsFree } from "./ports.mts";

describe("portIsFree", () => {
  it("a port held on 127.0.0.1 is held", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    try {
      expect(await portIsFree(port)).toBe(false);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
    expect(await portIsFree(port)).toBe(true);
  });

  it("no IPv6 on ::1 is skipped, not a holder; anything else is held", () => {
    expect(classifyBindError("EADDRNOTAVAIL", "::1")).toBe("no-such-address");
    expect(classifyBindError("EAFNOSUPPORT", "::1")).toBe("no-such-address");
    expect(classifyBindError("EADDRINUSE", "::1")).toBe("held");
    expect(classifyBindError("EADDRNOTAVAIL", "127.0.0.1")).toBe("held");
    expect(classifyBindError(undefined, undefined)).toBe("held");
  });
});
