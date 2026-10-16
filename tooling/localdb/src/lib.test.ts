import { createServer } from "node:net";
import type { Server } from "node:net";
import { describe, expect, it } from "vitest";
import {
  AUTO_SNAPSHOTS_KEPT,
  PORT_BASE,
  PORT_SLOTS,
  autoLabel,
  candidatePorts,
  classifyLock,
  databaseUrl,
  dbPaths,
  derivePort,
  loopbackPort,
  snapshotsToPrune,
  validLabel,
  validName,
} from "./lib.mts";
import { choosePort, portIsFree } from "./ports.mts";
import { exitCode, selectDatabases } from "./cli.mts";

describe("port derivation", () => {
  it("is stable for one checkout and database", () => {
    expect(derivePort("/a/checkout", "app")).toBe(derivePort("/a/checkout", "app"));
  });

  it("differs between two checkouts, and between two databases in one", () => {
    expect(derivePort("/work/main", "app")).not.toBe(
      derivePort("/work/main/.claude/worktrees/x", "app"),
    );
    expect(derivePort("/work/main", "app")).not.toBe(derivePort("/work/main", "audit"));
  });

  it("stays in the band, and the candidates step forward and wrap", () => {
    const ports = candidatePorts("/any", "db", 600);
    for (const p of ports) expect(p >= PORT_BASE && p < PORT_BASE + PORT_SLOTS).toBe(true);
    expect(ports[0]).toBe(derivePort("/any", "db"));
    expect(new Set(ports.slice(0, PORT_SLOTS)).size).toBe(PORT_SLOTS);
  });

  it("steps past a port somebody holds (a real bind)", async () => {
    const checkout = `/tmp/held-${process.pid}-${Date.now()}`;
    const first = derivePort(checkout, "db");
    const holder: Server = createServer();
    await new Promise<void>((r) => holder.listen(first, "127.0.0.1", r));
    try {
      expect(await portIsFree(first)).toBe(false);
      const choice = await choosePort(checkout, "db");
      expect(choice?.held).toContain(first);
      expect(choice?.port).not.toBe(first);
    } finally {
      await new Promise((r) => holder.close(r));
    }
  });

  it("answers null when every candidate is held", async () => {
    expect(await choosePort("/x", "db", async () => false)).toBeNull();
  });
});

describe("names and labels", () => {
  it("refuses path tricks", () => {
    expect(validName("app")).toBe(true);
    expect(validName("../etc")).toBe(false);
    expect(validName(".hidden")).toBe(false);
    expect(validLabel("before-the-big-change.v2")).toBe(true);
    expect(validLabel("../x")).toBe(false);
    expect(validLabel("a/b")).toBe(false);
    expect(validLabel("a..b")).toBe(false);
  });

  it("places everything under .localdb/<db>/", () => {
    const p = dbPaths("/repo", "app");
    expect(p.data).toBe("/repo/.localdb/app/data");
    expect(p.snapshots).toBe("/repo/.localdb/app/snapshots");
    expect(p.lock).toBe("/repo/.localdb/app/server.json");
  });

  it("makes sortable automatic labels", () => {
    expect(autoLabel("migrate", new Date("2026-10-15T10:15:30.123Z"))).toBe(
      "pre-migrate-20261015-101530-123",
    );
  });
});

describe("urls", () => {
  it("builds and reads back a loopback URL", () => {
    expect(loopbackPort(databaseUrl(55123))).toBe(55123);
    expect(loopbackPort("postgres://u@localhost/db")).toBe(5432);
    expect(loopbackPort("postgresql://u@db.example.com:55123/x")).toBeNull();
    expect(loopbackPort("not a url")).toBeNull();
    expect(loopbackPort("http://127.0.0.1:55123")).toBeNull();
  });
});

describe("the lock has three answers and a stale one", () => {
  const alive = () => true;
  const dead = () => false;
  const ready = JSON.stringify({
    pid: 42,
    state: "ready",
    port: 55000,
    url: databaseUrl(55000),
    control: { port: 60000, token: "t" },
    startedAt: "x",
  });

  it("absent is stopped", () => expect(classifyLock(null, alive)).toEqual({ state: "stopped" }));
  it("a live ready server is running", () =>
    expect(classifyLock(ready, alive).state).toBe("running"));
  it("a dead pid is stale, never running", () =>
    expect(classifyLock(ready, dead)).toEqual({ state: "stale", pid: 42 }));
  it("garbage is unreadable, not stopped", () => {
    expect(classifyLock("{", alive).state).toBe("unreadable");
    expect(classifyLock('{"pid":0}', alive).state).toBe("unreadable");
    expect(classifyLock('{"pid":1,"state":"weird"}', alive).state).toBe("unreadable");
  });
  it("a busy holder is reported as busy", () => {
    expect(classifyLock('{"pid":1,"state":"busy","op":"restore x"}', alive).state).toBe("busy");
  });
});

describe("pruning keeps the newest automatic snapshots and every manual one", () => {
  it(`keeps ${AUTO_SNAPSHOTS_KEPT}`, () => {
    const list = [
      ...Array.from({ length: 8 }, (_, i) => ({
        label: `pre-migrate-${i}`,
        bytes: 1,
        mtimeMs: i,
        auto: true,
      })),
      { label: "mine", bytes: 1, mtimeMs: -1, auto: false },
    ];
    expect(snapshotsToPrune(list)).toEqual(["pre-migrate-0", "pre-migrate-1", "pre-migrate-2"]);
  });
});

describe("cli selection", () => {
  const dbs = [{ name: "a" }, { name: "b" }];
  it("all by default for every-db commands, one required otherwise", () => {
    expect(selectDatabases(dbs, undefined, true)).toEqual({ dbs });
    expect(selectDatabases(dbs, undefined, false)).toHaveProperty("error");
    expect(selectDatabases([{ name: "a" }], undefined, false)).toEqual({ dbs: [{ name: "a" }] });
    expect(selectDatabases(dbs, "zz", true)).toEqual({
      error: 'no database named "zz" — declared: a, b',
    });
  });
  it("exit codes: failure beats could-not-ask beats ok", () => {
    expect(exitCode(["ok", "ok"])).toBe(0);
    expect(exitCode(["ok", "could-not-ask"])).toBe(3);
    expect(exitCode(["could-not-ask", "failed"])).toBe(1);
  });
});
