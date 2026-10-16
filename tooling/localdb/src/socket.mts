/**
 * The Postgres wire protocol in front of ONE PGlite backend, safe for many
 * connections.
 *
 * PGlite is a single Postgres session. The unnamed prepared statement and the
 * unnamed portal of the extended query protocol are per-session state, as is
 * the transaction, so connections cannot simply take turns **per message**:
 * one connection's Parse/Bind/Execute interleaved with another's fails as
 * `portal "" does not exist` (9 of 30 requests in docs/kit/spike-2026-10-evidence.md),
 * or worse, as a parameter bound to somebody else's statement.
 *
 * So the backend is held by one connection at a time, for a whole exchange:
 *
 * - from a connection's first message until the backend answers
 *   **ReadyForQuery** — after a `Sync` (extended protocol) or a `Query`
 *   (simple protocol, atomic on its own);
 * - and while that ReadyForQuery says the session is in a transaction
 *   (`T`, or `E` for a failed one), until it says idle (`I`) again. A long
 *   transaction therefore blocks every other connection — acceptable for a
 *   local database, and the price of not merging two clients' transactions.
 *
 * Other connections queue, first come first served. A connection that goes
 * away while holding the backend gets a `Sync` and, inside a transaction, a
 * `ROLLBACK` on its behalf, so it cannot leave the session wedged.
 *
 * `@electric-sql/pglite-socket` (0.2.13) has no such option: it queues single
 * messages and keeps affinity only inside a transaction, so this replaces it.
 *
 * Still shared, and not fixable without one backend per connection: named
 * prepared statements, `SET`, temp tables and `LISTEN`. A driver that prepares
 * statements by name (postgres.js by default) should be told not to.
 */
import { type Socket, createServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { PGlite } from "@electric-sql/pglite";

const PROTOCOL_3 = 196608;
const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

/** A FIFO mutex whose holder is named, so a connection can tell it holds it. */
export class SessionLock {
  private holder: object | null = null;
  private readonly waiting: Array<{ who: object; grant: () => void }> = [];

  /** Wait for the backend. With a timeout, resolves false instead of waiting longer. */
  acquire(who: object, timeoutMs?: number): Promise<boolean> {
    if (this.holder === who) return Promise.resolve(true);
    if (this.holder === null) {
      this.holder = who;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const entry = { who, grant: () => resolve(true) };
      this.waiting.push(entry);
      if (timeoutMs !== undefined)
        setTimeout(() => {
          const i = this.waiting.indexOf(entry);
          if (i === -1) return; // already granted
          this.waiting.splice(i, 1);
          resolve(false);
        }, timeoutMs).unref();
    });
  }

  release(who: object): void {
    if (this.holder !== who) return;
    const next = this.waiting.shift();
    this.holder = next?.who ?? null;
    next?.grant();
  }

  get held(): boolean {
    return this.holder !== null;
  }
}

/**
 * Follows the backend's output stream frame by frame — without buffering row
 * data — to see each ReadyForQuery and its transaction status, and drops the
 * ReadyForQuery frames PGlite sends where Postgres would not.
 *
 * PGlite answers an **error inside an extended exchange** with a
 * ReadyForQuery straight away, and then another for the Sync. A client counts
 * ReadyForQuery to match replies to requests, so the extra one shifts every
 * later reply by one (`pg`: "Received unexpected commandComplete message"),
 * and it would release the session lock before the exchange was over. Only a
 * Query, Sync, FunctionCall, CopyDone or CopyFail is answered with one.
 */
class BackendStream {
  private head = Buffer.alloc(0);
  private remaining = 0;
  private dropping = false;
  private capture = false;
  /** Status of the last forwarded ReadyForQuery since `expect`, or null. */
  status: string | null = null;
  private dropReady = false;

  /** Before each message: may its reply carry a ReadyForQuery? */
  expect(message: Uint8Array | "startup"): void {
    this.status = null;
    this.dropReady = message !== "startup" && !READY_AFTER.has(message[0]!);
  }

  /** The bytes of `chunk` to pass on to the client. */
  feed(chunk: Uint8Array): Buffer {
    const out: Uint8Array[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - i);
        if (this.capture) {
          this.status = String.fromCharCode(chunk[i]!);
          this.capture = false;
        }
        if (!this.dropping) out.push(chunk.subarray(i, i + take));
        i += take;
        this.remaining -= take;
        continue;
      }
      const take = Math.min(5 - this.head.length, chunk.length - i);
      this.head = Buffer.concat([this.head, chunk.subarray(i, i + take)]);
      i += take;
      if (this.head.length < 5) break;
      this.remaining = this.head.readInt32BE(1) - 4;
      const ready = this.head[0] === 0x5a; /* Z */
      this.dropping = ready && this.dropReady;
      this.capture = ready && !this.dropping && this.remaining > 0;
      if (!this.dropping) out.push(this.head);
      this.head = Buffer.alloc(0);
    }
    return Buffer.concat(out);
  }
}

/** Query, Sync, FunctionCall, CopyDone, CopyFail. */
const READY_AFTER = new Set([0x51, 0x53, 0x46, 0x63, 0x66]);

function errorResponse(code: string, message: string): Buffer {
  const body = Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`, "utf8");
  const head = Buffer.alloc(5);
  head.write("E", 0, "ascii");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const SYNC = new Uint8Array([0x53, 0, 0, 0, 4]);
function simpleQuery(sql: string): Uint8Array {
  const body = Buffer.from(`${sql}\0`, "utf8");
  const head = Buffer.alloc(5);
  head.write("Q", 0, "ascii");
  head.writeInt32BE(body.length + 4, 1);
  return new Uint8Array(Buffer.concat([head, body]));
}

class Connection {
  private buffer = Buffer.alloc(0);
  private started = false;
  private holding = false;
  private closed = false;
  private readonly backend = new BackendStream();
  /** Every message of this connection runs in order on this chain. */
  private chain: Promise<void> = Promise.resolve();
  /** Resolves once the socket has closed and the session has been left idle. */
  readonly finished: Promise<void>;
  private settle!: () => void;
  private readonly socket: Socket;
  private readonly db: PGlite;
  private readonly lock: SessionLock;
  private readonly greeting: Uint8Array;

  constructor(socket: Socket, db: PGlite, lock: SessionLock, greeting: Uint8Array) {
    this.socket = socket;
    this.db = db;
    this.lock = lock;
    this.greeting = greeting;
    this.finished = new Promise((resolve) => (this.settle = resolve));
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.chain = this.chain.then(() => this.drain()).catch((err: Error) => this.fail(err));
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.closed = true;
      this.chain = this.chain
        .then(() => this.cleanup())
        .catch(() => {})
        .finally(() => this.settle());
    });
  }

  private write(data: Uint8Array): void {
    if (data.length > 0 && !this.socket.destroyed && this.socket.writable) this.socket.write(data);
  }

  /** Run one frame against the backend; `forward` false discards the output. */
  private async exec(message: Uint8Array, forward = true): Promise<void> {
    this.backend.expect(message);
    await this.db.runExclusive(() =>
      this.db.execProtocolRawStream(message, {
        onRawData: (data) => {
          const pass = this.backend.feed(data);
          if (forward) this.write(pass);
        },
      }),
    );
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      if (!this.started) {
        if (this.buffer.length < 8) return;
        const len = this.buffer.readInt32BE(0);
        const code = this.buffer.readInt32BE(4);
        if (this.buffer.length < len) return;
        this.buffer = this.buffer.subarray(len);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
          this.write(Buffer.from("N")); // no encryption; the client carries on in clear
          continue;
        }
        if (code === CANCEL_REQUEST) {
          // There is no backend process to signal; the protocol expects no reply.
          this.socket.end();
          return;
        }
        if (code !== PROTOCOL_3) {
          this.write(errorResponse("08P01", `unsupported protocol code ${code}`));
          this.socket.end();
          return;
        }
        // Answered from the greeting PGlite gave once, at server start: a
        // startup sent through the backend mid-transaction would wait for the
        // session lock, so nobody could connect while a transaction is open.
        this.started = true;
        this.write(this.greeting);
        continue;
      }
      if (this.buffer.length < 5) return;
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) return;
      const message = this.buffer.subarray(0, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      if (message[0] === 0x58 /* X, Terminate */) {
        this.socket.end();
        return;
      }
      await this.step(message);
    }
  }

  /** One frame under the session lock; let go once the backend is idle again. */
  private async step(message: Uint8Array): Promise<void> {
    if (!this.holding) {
      await this.lock.acquire(this);
      this.holding = true;
    }
    if (this.closed) return; // cleanup releases it
    await this.exec(new Uint8Array(message));
    if (this.backend.status === "I") this.release();
  }

  private release(): void {
    this.holding = false;
    this.lock.release(this);
  }

  /** Leave the session as a new connection would expect it: synced and idle. */
  private async cleanup(): Promise<void> {
    if (!this.holding) return;
    try {
      // Ends an unfinished extended exchange (and an error's skip-until-Sync).
      await this.exec(SYNC, false);
      if (this.backend.status !== "I") await this.exec(simpleQuery("ROLLBACK"), false);
    } finally {
      this.release();
    }
  }

  private fail(err: Error): void {
    this.write(errorResponse("XX000", `localdb: ${err.message}`));
    this.socket.destroy();
  }
}

/**
 * The backend's answer to a startup message — authentication ok, parameter
 * status, ReadyForQuery — asked once and replayed to every connection. PGlite
 * is one session whatever user or database a client names, so the answer does
 * not depend on the client. Refuses a greeting that does not end idle.
 */
async function greet(db: PGlite): Promise<Uint8Array> {
  const params = Buffer.from("user\0postgres\0database\0postgres\0\0", "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32BE(params.length + 8, 0);
  head.writeInt32BE(PROTOCOL_3, 4);
  const reply = await db.runExclusive(() =>
    db.execProtocolRaw(new Uint8Array(Buffer.concat([head, params]))),
  );
  const backend = new BackendStream();
  backend.expect("startup");
  backend.feed(reply);
  if (backend.status !== "I")
    throw new Error(`localdb: PGlite's startup reply did not end ReadyForQuery idle`);
  return reply;
}

export interface SocketServer {
  port: number;
  /** The backend's lock, so other work (a snapshot) can wait for an idle session. */
  lock: SessionLock;
  stop(): Promise<void>;
}

/** Serve `db` on host:port. Connections beyond `maxConnections` are refused with 53300. */
export async function serveSocket(
  db: PGlite,
  opts: { port: number; host: string; maxConnections?: number },
): Promise<SocketServer> {
  await db.waitReady;
  const greeting = await greet(db);
  const lock = new SessionLock();
  const connections = new Set<Connection>();
  const max = opts.maxConnections ?? 100;
  const server = createServer((socket) => {
    if (connections.size >= max) {
      socket.end(errorResponse("53300", `too many connections (${max})`));
      return;
    }
    const conn = new Connection(socket, db, lock, greeting);
    connections.add(conn);
    void conn.finished.then(() => connections.delete(conn));
  });
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    lock,
    async stop() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const s of sockets) s.destroy();
      await closed;
      await Promise.all([...connections].map((c) => c.finished));
    },
  };
}
