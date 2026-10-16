/**
 * The background process `db:local start` spawns: one PGlite on a data
 * directory, served over the Postgres wire protocol, plus a control channel
 * so a snapshot can be taken **without stopping it**.
 *
 * PGlite is in-process, so only this process can dump its data directory; the
 * control channel is how the CLI asks it to. It is HTTP on 127.0.0.1 with a
 * random port and a token, both recorded in the lock file, and it accepts only
 * a label — it writes into its own snapshots directory and nowhere else.
 *
 *   node server.mts --name <db> --data <dir> --snapshots <dir> --lock <file> --port <n>
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { SNAPSHOT_EXT, databaseUrl, validLabel } from "./lib.mts";
import type { Lock } from "./lib.mts";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    data: { type: "string" },
    snapshots: { type: "string" },
    lock: { type: "string" },
    port: { type: "string" },
  },
});
const { name, data, snapshots, lock } = values;
const port = Number(values.port);
if (!name || !data || !snapshots || !lock || !Number.isInteger(port)) {
  console.error("server.mts: --name, --data, --snapshots, --lock and --port are required");
  process.exit(2);
}

const say = (line: string) => console.log(`[localdb ${name}] ${new Date().toISOString()} ${line}`);

mkdirSync(data, { recursive: true });
mkdirSync(snapshots, { recursive: true });

const db = await PGlite.create({ dataDir: data });
/*
 * maxConnections defaults to 1, and an app with a pool then deadlocks on its
 * second concurrent query. Many connections are multiplexed onto one Postgres
 * session — which is also why a client should open ONE (see agents.md).
 */
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 100 });
await server.start();
say(`serving ${data} on 127.0.0.1:${port}`);

/** Dump the data directory to `<snapshots>/<label>.tar.gz`, atomically. */
async function snapshot(label: string): Promise<{ path: string; bytes: number }> {
  // A checkpoint first, so the tarball does not lean on WAL replay. Inside a
  // client's open transaction it cannot run; the dump is still consistent,
  // because loading it recovers and the open transaction rolls back.
  if (!db.isInTransaction()) await db.exec("CHECKPOINT").catch(() => {});
  const dump = await db.dumpDataDir("gzip");
  const bytes = Buffer.from(await dump.arrayBuffer());
  const path = join(snapshots!, `${label}${SNAPSHOT_EXT}`);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
  return { path, bytes: bytes.length };
}

const token = randomBytes(16).toString("hex");
const control = createHttpServer((req, res) => {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers["x-localdb-token"] !== token)
    return reply(403, { ok: false, error: "bad token" });
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/ping")
    return reply(200, { ok: true, pid: process.pid });
  if (req.method === "POST" && url.pathname === "/snapshot") {
    const label = url.searchParams.get("label") ?? "";
    if (!validLabel(label))
      return reply(400, { ok: false, error: `invalid label ${JSON.stringify(label)}` });
    snapshot(label).then(
      (r) => {
        say(`snapshot ${label}: ${r.bytes} bytes`);
        reply(200, { ok: true, ...r });
      },
      (err: Error) => reply(500, { ok: false, error: err.message }),
    );
    return;
  }
  reply(404, { ok: false, error: "not found" });
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlPort = (control.address() as AddressInfo).port;

const ready: Lock = {
  pid: process.pid,
  state: "ready",
  port,
  url: databaseUrl(port),
  control: { port: controlPort, token },
  startedAt: new Date().toISOString(),
};
const temp = `${lock}.${process.pid}.tmp`;
writeFileSync(temp, `${JSON.stringify(ready, null, 2)}\n`, { mode: 0o600 });
renameSync(temp, lock);
say(`ready; control channel on 127.0.0.1:${controlPort}`);

let stopping: Promise<void> | undefined;
async function stop(signal: string): Promise<void> {
  say(`${signal}: stopping`);
  control.close();
  await server.stop();
  await db.close();
  // Remove the lock only if it is still ours — a later start may have replaced it.
  try {
    const held = JSON.parse(readFileSync(lock!, "utf8")) as Lock;
    if (held.pid === process.pid) rmSync(lock!, { force: true });
  } catch {
    // Already gone, or not ours to judge.
  }
  say("stopped cleanly");
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping ??= stop(signal).then(
      () => process.exit(0),
      (err: Error) => {
        console.error(`stop failed: ${err.message}`);
        process.exit(1);
      },
    );
  });
