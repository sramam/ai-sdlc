// The database client on Workers: node-postgres through Hyperdrive, one client
// per request. Never at module scope — a socket opened in one request cannot be
// used from another (workerd refuses cross-request I/O), and Hyperdrive is the
// pool, so a per-request connect is cheap.
//
// Runtime-free: Hyperdrive is passed in as `{ connectionString }`, so the same
// module runs in Node against PGlite in tests.
import { Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type ConnectionSource = { connectionString: string };

export async function openDb(
  source: ConnectionSource,
): Promise<{ db: Db; close(): Promise<void> }> {
  const client = new Client({ connectionString: source.connectionString });
  await client.connect();
  return { db: drizzle(client, { schema }), close: () => client.end() };
}

export async function withDb<T>(source: ConnectionSource, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = await openDb(source);
  try {
    return await fn(db);
  } finally {
    await close();
  }
}
