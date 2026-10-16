/**
 * The real thing: a PGlite socket server in a temporary checkout, spoken to
 * over the wire protocol, snapshotted, restored and reset.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { dbPaths, derivePort, snapshotFile } from "./lib.mts";
import * as ops from "./localdb.mts";
import type { Ctx } from "./localdb.mts";
import { main } from "./cli.mts";
import { query } from "./wire.mts";

const WIRE = join(import.meta.dirname, "wire.mts");

let root: string;
const lines: string[] = [];
let ctx: Ctx;
const db = {
  name: "main",
  // Fails unless the extra variable received the same URL as DATABASE_URL.
  migrate: `test "$EXTRA_URL" = "$DATABASE_URL" && node ${WIRE} "create table if not exists migrated (id int)"`,
  env: ["EXTRA_URL"],
};

async function sql(text: string) {
  const r = await ops.runningUrl(root, "main");
  if (r.state !== "running") throw new Error(`not running: ${r.reason}`);
  return query(r.port, text);
}
const count = async (table: string) =>
  Number((await sql(`select count(*) as n from ${table}`)).rows[0]?.n);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "localdb-test-"));
  ctx = { root, log: (l) => lines.push(l) };
});

afterAll(async () => {
  await ops.stop(ctx, db);
  rmSync(root, { recursive: true, force: true });
});

describe("db:local against a real PGlite socket server", { timeout: 60_000 }, () => {
  it("starts on the derived port and answers SQL over the wire", async () => {
    expect(await ops.start(ctx, db)).toBe("ok");
    const r = await ops.runningUrl(root, "main");
    expect(r.state).toBe("running");
    if (r.state === "running") expect(r.port).toBe(derivePort(root, "main"));
    await sql("create table items (id int primary key, name text)");
    await sql("insert into items values (1, 'one'), (2, 'two')");
    expect(await count("items")).toBe(2);
  });

  it("start again is ok and says it is already running", async () => {
    expect(await ops.start(ctx, db)).toBe("ok");
    expect(lines.at(-1)).toMatch(/already running/);
  });

  it("snapshot → change → restore brings the data back", async () => {
    expect(await ops.snapshot(ctx, db, "two-items")).toBe("ok");
    expect(existsSync(snapshotFile(dbPaths(root, "main"), "two-items"))).toBe(true);
    expect(await ops.snapshot(ctx, db, "two-items")).toBe("failed"); // exists, no --force
    await sql("insert into items values (3, 'three')");
    expect(await count("items")).toBe(3);

    expect(await ops.restore(ctx, db, "two-items")).toBe("failed"); // running, no --force
    expect(await ops.restore(ctx, db, "two-items", { force: true })).toBe("ok");
    expect(await count("items")).toBe(2);
  });

  it("a snapshot of a stopped database round-trips through PGlite's own API", async () => {
    expect(await ops.stop(ctx, db)).toBe("ok");
    expect(await ops.snapshot(ctx, db, "stopped")).toBe("ok");
    const file = snapshotFile(dbPaths(root, "main"), "stopped");
    const { readFileSync } = await import("node:fs");
    const pg = await PGlite.create({ loadDataDir: new Blob([readFileSync(file)]) });
    const r = await pg.query<{ n: number }>("select count(*)::int as n from items");
    expect(r.rows[0]?.n).toBe(2);
    await pg.close();
    expect(await ops.restore(ctx, db, "nope")).toBe("failed");
  });

  it("migrate refuses when stopped, then snapshots first and passes the URL", async () => {
    expect(await ops.migrate(ctx, db)).toBe("failed");
    expect(await ops.start(ctx, db)).toBe("ok");
    expect(await ops.migrate(ctx, db)).toBe("ok");
    expect(await count("migrated")).toBe(0);
    expect(
      ops.listSnapshots(dbPaths(root, "main")).some((s) => s.label.startsWith("pre-migrate-")),
    ).toBe(true);
  });

  it("reset refuses while running, then empties and migrates", async () => {
    expect(await ops.reset(ctx, db)).toBe("failed");
    expect(await ops.reset(ctx, db, { force: true })).toBe("ok");
    await expect(sql("select * from items")).rejects.toThrow(/does not exist/);
    expect(await count("migrated")).toBe(0);
    expect(
      ops.listSnapshots(dbPaths(root, "main")).some((s) => s.label.startsWith("pre-reset-")),
    ).toBe(true);
  });

  it("status, url and stop print a line each, and url fails once stopped", async () => {
    const out: string[] = [];
    const cfg = { localdb: { databases: [db] } } as never;
    expect(await main(["status"], cfg, root, (l) => out.push(l))).toBe(0);
    expect(out.at(-1)).toMatch(/running {2}port \d+/);
    expect(await main(["url"], cfg, root, (l) => out.push(l))).toBe(0);
    expect(out.at(-1)).toMatch(/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres/);
    expect(await main(["stop"], cfg, root, (l) => out.push(l))).toBe(0);
    expect(existsSync(dbPaths(root, "main").lock)).toBe(false);
    expect(await main(["url"], cfg, root, (l) => out.push(l))).toBe(1);
  });

  it("a lock naming a dead pid is cleared and said, never trusted", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      dbPaths(root, "main").lock,
      JSON.stringify({ pid: 999_999, state: "ready", startedAt: "x" }),
    );
    expect(await ops.start(ctx, db)).toBe("ok");
    expect(lines.some((l) => /cleared a stale lock/.test(l))).toBe(true);
  });
});
