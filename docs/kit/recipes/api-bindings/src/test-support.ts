// Shared by the suites: a PGlite database, an authz whose answers a test sets,
// two people in two organizations, and each binding wired the way an app wires
// it. Credentials here are test fixtures, verified by a stand-in key store.
import { PGlite } from "@electric-sql/pglite";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { drizzle } from "drizzle-orm/pglite";
import type { Deps } from "../../api/src/capability";
import type { ActiveRelationship } from "../../api/src/caller";
import { exclusions, manifest } from "../../api/src/manifest";
import { scriptedAuthz } from "../../api/src/scripted-authz";
import {
  authenticate,
  toAuthenticated,
  type Authenticated,
  type Principal,
  type Verifiers,
} from "./auth/principal";
import { createHttpHandler, type HttpOptions } from "./http/router";
import { mcpServer, type McpOptions } from "./mcp/server";

export const APP = "http://app.test";
export const BASE = "/api";

export type World = {
  db: ReturnType<typeof drizzle>;
  authz: ReturnType<typeof scriptedAuthz>;
};

export async function newWorld(): Promise<World> {
  const pg = new PGlite();
  // In a project: the drizzle-kit migrations, applied by createTestDb (db recipe).
  await pg.exec(`
    create table project (
      id text primary key, tenant_id text not null, name text not null,
      created_by text not null, created_at timestamptz not null default now());
    create unique index project_tenant_name on project (tenant_id, name);`);
  return { db: drizzle(pg), authz: scriptedAuthz({}) };
}

export const RELATIONSHIPS: Record<string, ActiveRelationship & { userId: string }> = {
  "rel-alice": { userId: "u-alice", tenantId: "org-a", role: "admin", party: null },
  "rel-bruno": { userId: "u-bruno", tenantId: "org-b", role: "admin", party: null },
};

/** API keys, as the key store would verify them (better-auth.test.ts verifies real ones). */
export const KEYS: Record<string, Principal> = {
  "key-alice": {
    userId: "u-alice",
    via: "api-key",
    scopes: ["api:read", "api:write"],
    relationshipId: "rel-alice",
    rateKey: "key:1",
  },
  "key-alice-ro": {
    userId: "u-alice",
    via: "api-key",
    scopes: ["api:read"],
    relationshipId: "rel-alice",
    rateKey: "key:2",
  },
  "key-bruno": {
    userId: "u-bruno",
    via: "api-key",
    scopes: ["api:read", "api:write"],
    relationshipId: "rel-bruno",
    rateKey: "key:3",
  },
  "key-revoked": {
    userId: "u-alice",
    via: "api-key",
    scopes: ["api:read", "api:write"],
    relationshipId: "rel-bruno", // bound to a relationship that is not Alice's
    rateKey: "key:4",
  },
};

export const verifiers = (over: Partial<Verifiers> = {}): Verifiers => ({
  appOrigin: APP,
  session: async () => null,
  apiKey: async (key) => KEYS[key] ?? null,
  // Re-read live, and only if it still belongs to this user.
  activeRelationship: async (p) => {
    const r = p.relationshipId ? RELATIONSHIPS[p.relationshipId] : undefined;
    if (!r || r.userId !== p.userId) return null;
    return { tenantId: r.tenantId, role: r.role, party: r.party };
  },
  ...over,
});

export async function who(key: string): Promise<Authenticated> {
  const a = await toAuthenticated(KEYS[key]!, verifiers());
  if ("ok" in a) throw new Error(a.detail);
  return a;
}

const deps = (w: World): Deps => ({ db: w.db, authz: w.authz });

export function http(w: World, over: Partial<HttpOptions> = {}) {
  return createHttpHandler({
    manifest,
    exclusions,
    basePath: BASE,
    authenticate: (r) => authenticate(r, verifiers()),
    deps: () => deps(w),
    ...over,
  });
}

export const mcpOptions = (w: World, over: Partial<McpOptions> = {}): McpOptions => ({
  manifest,
  exclusions,
  info: { name: "app", version: "0.0.0" },
  deps: () => deps(w),
  ...over,
});

/** An MCP client connected in process to a server acting for `key`'s caller. */
export async function mcpClient(w: World, key: string, over: Partial<McpOptions> = {}) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcpServer(mcpOptions(w, over), await who(key)).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

/** A tool result as the port's answer: the output, or the refusal. */
export function fromTool(r: { isError?: boolean; structuredContent?: unknown; content?: unknown }) {
  return r.structuredContent as Record<string, unknown>;
}
