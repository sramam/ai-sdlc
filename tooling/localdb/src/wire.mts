/**
 * A dependency-free Postgres client for the **simple query** protocol: start up,
 * send one query string, read text rows back. It exists so `db:local` can ask a
 * running server "do you answer?" and so tests can prove the socket server
 * serves, without adding `pg` to the starter.
 *
 * Deliberately tiny: no extended protocol, no binary formats, no SSL, no
 * authentication beyond "trust" (which is what the PGlite socket server does).
 * Values come back as text. It is not a driver and must not grow into one —
 * an application uses its ORM's.
 *
 *   DATABASE_URL=… node tooling/localdb/src/wire.mts "select 1"
 */
import { connect } from "node:net";
import { isEntry } from "../../core/src/exec.mts";

export interface QueryResult {
  /** Rows from every statement, values as text (null for SQL NULL). */
  rows: Array<Record<string, string | null>>;
  /** One command tag per statement, e.g. "INSERT 0 1". */
  commands: string[];
}

export class WireError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "WireError";
    this.code = code;
  }
}

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, "ascii");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function startup(user: string, database: string): Buffer {
  const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`, "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32BE(params.length + 8, 0);
  head.writeInt32BE(196608, 4); // protocol 3.0
  return Buffer.concat([head, params]);
}

function errorFields(body: Buffer): { message: string; code?: string } {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const key = String.fromCharCode(body[i]!);
    const end = body.indexOf(0, i + 1);
    fields[key] = body.toString("utf8", i + 1, end);
    i = end + 1;
  }
  return { message: fields.M ?? "unknown error", code: fields.C };
}

/** Run `sql` (one or more statements) against host:port. Rejects on any server error. */
export function query(
  port: number,
  sql: string,
  opts: { host?: string; user?: string; database?: string; timeoutMs?: number } = {},
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: opts.host ?? "127.0.0.1" });
    const result: QueryResult = { rows: [], commands: [] };
    let columns: string[] = [];
    let buffer = Buffer.alloc(0);
    let sent = false;
    let failure: WireError | null = null;
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end(message("X", Buffer.alloc(0)));
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(new WireError(`no answer from 127.0.0.1:${port} in ${opts.timeoutMs ?? 10_000}ms`)),
      opts.timeoutMs ?? 10_000,
    );
    socket.on("error", (err) =>
      finish(new WireError(err.message, (err as NodeJS.ErrnoException).code)),
    );
    socket.on("close", () => finish(new WireError("connection closed before the query completed")));
    socket.on("connect", () =>
      socket.write(startup(opts.user ?? "postgres", opts.database ?? "postgres")),
    );
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const type = String.fromCharCode(buffer[0]!);
        const len = buffer.readInt32BE(1);
        if (buffer.length < len + 1) break;
        const body = buffer.subarray(5, len + 1);
        buffer = buffer.subarray(len + 1);
        if (type === "R") {
          const kind = body.readInt32BE(0);
          if (kind !== 0)
            return finish(
              new WireError(
                `server asked for authentication (type ${kind}); only trust is supported`,
              ),
            );
        } else if (type === "E") {
          const e = errorFields(body);
          failure ??= new WireError(e.message, e.code);
          // Before the query is sent an error ends the session; after, wait for Z.
          if (!sent) return finish(failure);
        } else if (type === "T") {
          const n = body.readInt16BE(0);
          columns = [];
          let i = 2;
          for (let c = 0; c < n; c++) {
            const end = body.indexOf(0, i);
            columns.push(body.toString("utf8", i, end));
            i = end + 1 + 18; // name\0, then table oid, attnum, type oid, size, modifier, format
          }
        } else if (type === "D") {
          const n = body.readInt16BE(0);
          const row: Record<string, string | null> = {};
          let i = 2;
          for (let c = 0; c < n; c++) {
            const size = body.readInt32BE(i);
            i += 4;
            row[columns[c] ?? `column${c}`] = size < 0 ? null : body.toString("utf8", i, i + size);
            if (size > 0) i += size;
          }
          result.rows.push(row);
        } else if (type === "C") {
          result.commands.push(body.toString("utf8", 0, body.length - 1));
        } else if (type === "Z") {
          if (!sent) {
            sent = true;
            socket.write(message("Q", Buffer.from(`${sql}\0`, "utf8")));
          } else return finish(failure);
        }
        // S (parameter status), K (backend key), N (notice), I (empty query): nothing to do.
      }
    });
  });
}

/** True when something on host:port answers `select 1` as Postgres would. */
export async function answers(port: number, timeoutMs = 5_000): Promise<boolean> {
  try {
    const r = await query(port, "select 1 as ok", { timeoutMs });
    return r.rows[0]?.ok === "1";
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  const sql = process.argv.slice(2).join(" ");
  if (!url || !sql) {
    console.error('usage: DATABASE_URL=postgresql://…@127.0.0.1:<port>/… node wire.mts "<sql>"');
    process.exit(2);
  }
  const u = new URL(url);
  try {
    const r = await query(Number(u.port || "5432"), sql, {
      host: u.hostname.replace(/^\[|\]$/g, ""),
    });
    for (const row of r.rows) console.log(JSON.stringify(row));
    console.log(r.commands.join("; "));
  } catch (err) {
    console.error(`failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
