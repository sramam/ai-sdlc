/**
 * Many connections against one PGlite backend, through the real background
 * server, with `pg` — the driver an application actually uses.
 *
 * Before the session lock, 9 of 30 concurrent requests failed with
 * `portal "" does not exist`: the unnamed statement and portal of the extended
 * query protocol are per-session state, and interleaved Parse/Bind/Execute from
 * different connections clobbered each other (docs/kit/spike-2026-10-evidence.md).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import * as ops from "./localdb.mts";
import type { Ctx } from "./localdb.mts";

let root: string;
let ctx: Ctx;
let port: number;
const db = { name: "conc", migrate: "true" };

const client = async () => {
  const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await c.connect();
  return c;
};

const frame = (type: string, body: Buffer) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, "ascii");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};

/**
 * One extended-protocol query with each message in its **own write**, a tick
 * apart — how a proxy such as Hyperdrive forwards them, and the shape that
 * interleaves with other connections. `pg` writes all five in one chunk, which
 * hid the fault from a pg-only test.
 */
function splitExtended(text: string, param: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    let buffer = Buffer.alloc(0);
    let started = false;
    let value: string | undefined;
    let error: string | undefined;
    const tick = () => new Promise((r) => setTimeout(r, 1));
    socket.on("error", reject);
    socket.on("connect", () => {
      const params = Buffer.from("user\0postgres\0database\0postgres\0\0");
      const head = Buffer.alloc(8);
      head.writeInt32BE(params.length + 8, 0);
      head.writeInt32BE(196608, 4);
      socket.write(Buffer.concat([head, params]));
    });
    socket.on("data", async (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const type = String.fromCharCode(buffer[0]!);
        const len = buffer.readInt32BE(1);
        if (buffer.length < len + 1) break;
        const body = buffer.subarray(5, len + 1);
        buffer = buffer.subarray(len + 1);
        if (type === "E") error = body.toString("utf8").replace(/\0/g, " ");
        if (type === "D") value = body.toString("utf8", 6, 6 + body.readInt32BE(2));
        if (type !== "Z") continue;
        if (started) {
          socket.end(frame("X", Buffer.alloc(0)));
          if (error) reject(new Error(error));
          else resolve(value ?? "");
          return;
        }
        started = true;
        const p = Buffer.from(param);
        const len4 = Buffer.alloc(4);
        len4.writeInt32BE(p.length);
        const messages = [
          frame("P", Buffer.concat([Buffer.from(`\0${text}\0`), Buffer.from([0, 0])])),
          frame(
            "B",
            Buffer.concat([
              Buffer.from("\0\0"),
              Buffer.from([0, 0, 0, 1]),
              len4,
              p,
              Buffer.from([0, 0]),
            ]),
          ),
          frame("E", Buffer.concat([Buffer.from("\0"), Buffer.from([0, 0, 0, 0])])),
          frame("S", Buffer.alloc(0)),
        ];
        for (const m of messages) {
          socket.write(m);
          await tick();
        }
      }
    });
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "localdb-conc-"));
  ctx = { root, log: () => {} };
  expect(await ops.start(ctx, db)).toBe("ok");
  const r = await ops.runningUrl(root, "conc");
  if (r.state !== "running") throw new Error(`not running: ${r.reason}`);
  port = r.port;
  const c = await client();
  await c.query("create table if not exists t (id int primary key, by text not null)");
  await c.end();
}, 60_000);

afterAll(async () => {
  await ops.stop(ctx, db);
  rmSync(root, { recursive: true, force: true });
});

describe("one PGlite backend, many connections", { timeout: 60_000 }, () => {
  it("40 concurrent clients whose Parse/Bind/Execute/Sync arrive as separate writes", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => splitExtended("select $1::text as v", `c${i}`)),
    );
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);
    expect(results.map((r) => (r as PromiseFulfilledResult<string>).value)).toEqual(
      Array.from({ length: 40 }, (_, i) => `c${i}`),
    );
  });

  it("serves 40 concurrent clients doing extended-protocol queries", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, async (_, i) => {
        const c = await client();
        try {
          let sum = 0;
          for (let k = 0; k < 5; k++) {
            // Parameters force Parse/Bind/Describe/Execute/Sync on the unnamed portal.
            const r = await c.query<{ n: number; s: string }>(
              "select $1::int + $2::int as n, $3::text as s from generate_series(1, 3)",
              [i, k, `client-${i}`],
            );
            expect(r.rows).toHaveLength(3);
            expect(r.rows[0]?.s).toBe(`client-${i}`);
            sum += r.rows[0]!.n;
          }
          return sum;
        } finally {
          await c.end();
        }
      }),
    );
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);
    results.forEach((r, i) => expect((r as PromiseFulfilledResult<number>).value).toBe(5 * i + 10));
  });

  it("a pooled client (pg.Pool, max 20) under 60 concurrent queries", async () => {
    const pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", max: 20 });
    try {
      const rows = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          pool.query<{ v: string }>("select $1::text as v", [`v${i}`]).then((r) => r.rows[0]?.v),
        ),
      );
      expect(rows).toEqual(Array.from({ length: 60 }, (_, i) => `v${i}`));
    } finally {
      await pool.end();
    }
  });

  it("an error mid-exchange keeps every client's replies in step", async () => {
    // PGlite sends an extra ReadyForQuery after an extended-protocol error; it
    // must not reach the client nor release the backend before the Sync.
    const values = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const c = await client();
        try {
          await expect(c.query("select $1::int / 0 as boom", [i])).rejects.toThrow(
            /division by zero/,
          );
          const r = await c.query<{ v: number }>("select $1::int as v", [i]);
          return r.rows[0]?.v;
        } finally {
          await c.end();
        }
      }),
    );
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("interleaved transactions do not see or break each other", async () => {
    const a = await client();
    const b = await client();
    try {
      await a.query("BEGIN");
      await a.query("insert into t values ($1, $2)", [1, "a"]);
      // b's BEGIN must wait for a's transaction to end, not join it.
      const bDone = (async () => {
        await b.query("BEGIN");
        await b.query("insert into t values ($1, $2)", [2, "b"]);
        await b.query("COMMIT");
      })();
      await new Promise((r) => setTimeout(r, 50));
      await a.query("insert into t values ($1, $2)", [3, "a"]);
      await a.query("COMMIT");
      await bDone;
      const r = await a.query<{ id: number; by: string }>("select id, by from t order by id");
      expect(r.rows).toEqual([
        { id: 1, by: "a" },
        { id: 2, by: "b" },
        { id: 3, by: "a" },
      ]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("a rollback stays a rollback, and an aborted transaction does not leak", async () => {
    const a = await client();
    const b = await client();
    try {
      await a.query("BEGIN");
      await a.query("insert into t values ($1, $2)", [10, "a"]);
      await expect(a.query("insert into t values ($1, $2)", [10, "dup"])).rejects.toThrow(
        /duplicate key/,
      );
      const bRead = b.query<{ n: number }>("select count(*)::int as n from t where id = $1", [10]);
      await a.query("ROLLBACK");
      expect((await bRead).rows[0]?.n).toBe(0);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("a client that disconnects inside a transaction is rolled back and frees the backend", async () => {
    const a = await client();
    a.on("error", () => {});
    await a.query("BEGIN");
    await a.query("insert into t values ($1, $2)", [20, "gone"]);
    const b = await client();
    try {
      const bRead = b.query<{ n: number }>("select count(*)::int as n from t where id = $1", [20]);
      // Drop the socket without COMMIT or Terminate.
      (a as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
      expect((await bRead).rows[0]?.n).toBe(0);
      expect((await b.query("select 1 as one")).rows[0]).toEqual({ one: 1 });
    } finally {
      await b.end();
    }
  });

  it("concurrent transactions each commit whole", async () => {
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const c = await client();
        try {
          await c.query("BEGIN");
          for (let k = 0; k < 3; k++)
            await c.query("insert into t values ($1, $2)", [100 + i * 10 + k, `tx${i}`]);
          await c.query("COMMIT");
        } finally {
          await c.end();
        }
      }),
    );
    const c = await client();
    try {
      const r = await c.query<{ by: string; n: number }>(
        "select by, count(*)::int as n from t where id >= 100 group by by order by by",
      );
      expect(r.rows).toHaveLength(10);
      for (const row of r.rows) expect(row.n).toBe(3);
    } finally {
      await c.end();
    }
  });
});
