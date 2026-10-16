// API key → Caller, against a real Better Auth 1.7.9 with the api-key plugin
// (memory adapter, in process). The key carries the user and a relationship
// id, both written server-side at creation; the request carries only the key.
import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { authenticate, principalFromClaims } from "./principal";
import { betterAuthVerifiers, scopesFromPermissions, type BetterAuthApi } from "./better-auth";
import { APP, RELATIONSHIPS } from "../test-support";

async function setup() {
  const db: Record<string, unknown[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    apikey: [],
  };
  const auth = betterAuth({
    // A per-run random secret: test-only, never a literal.
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: APP,
    database: memoryAdapter(db),
    plugins: [
      apiKey({
        defaultPrefix: "app_",
        enableMetadata: true,
        // 1.7.9 defaults to 10 requests per key per day; the binding owns rate limiting.
        rateLimit: { enabled: false },
      }),
    ],
  });
  const ctx = await auth.$context;
  const alice = await ctx.internalAdapter.createUser(
    { email: "alice@example.test", name: "Alice", emailVerified: true },
    { method: "admin" },
  );
  const mint = async (
    permissions: Record<string, string[]> | undefined,
    relationshipId = "rel-alice",
  ) =>
    (
      await auth.api.createApiKey({
        body: { userId: alice.id, permissions, metadata: { relationshipId } },
      })
    ).key;
  RELATIONSHIPS["rel-ba"] = { userId: alice.id, tenantId: "org-a", role: "admin", party: null };
  const v = {
    appOrigin: APP,
    ...betterAuthVerifiers(auth as unknown as BetterAuthApi),
    activeRelationship: async (p: { userId: string; relationshipId?: string }) => {
      const r = p.relationshipId ? RELATIONSHIPS[p.relationshipId] : undefined;
      return r && r.userId === p.userId
        ? { tenantId: r.tenantId, role: r.role, party: r.party }
        : null;
    },
  };
  const req = (key: string) =>
    new Request(`${APP}/api/project/list`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
  return { alice, mint, v, req };
}

describe("an API key, verified by Better Auth", () => {
  it("resolves to its user's Caller in the relationship bound at creation", async () => {
    const { alice, mint, v, req } = await setup();
    const who = await authenticate(req(await mint({ api: ["read", "write"] }, "rel-ba")), v);
    expect(who).toMatchObject({
      caller: { userId: alice.id, tenantId: "org-a", role: "admin" },
      scopes: ["api:read", "api:write"],
      rateKey: expect.stringMatching(/^key:/),
    });
  });

  it("an unknown key is no credential (401), not an error", async () => {
    const { v, req } = await setup();
    expect(await authenticate(req("app_not-a-key"), v)).toBeNull();
  });

  it("a key bound to a relationship that is not its user's is refused", async () => {
    const { mint, v, req } = await setup();
    expect(await authenticate(req(await mint({ api: ["write"] }, "rel-bruno")), v)).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
  });

  it("a key with no api permission can do nothing (default deny)", async () => {
    const { mint, v, req } = await setup();
    expect(await authenticate(req(await mint(undefined, "rel-ba")), v)).toMatchObject({
      scopes: [],
    });
    expect(scopesFromPermissions({ api: ["read", "admin"] })).toEqual(["api:read"]);
  });
});

describe("OAuth claims (MCP), once verified", () => {
  it("sub, known scopes, the bound relationship, a per-client rate key", () => {
    expect(
      principalFromClaims({
        sub: "u1",
        scope: "openid api:read admin",
        relationship_id: "r1",
        client_id: "c1",
      }),
    ).toEqual({
      userId: "u1",
      via: "oauth",
      scopes: ["api:read"],
      relationshipId: "r1",
      rateKey: "client:c1:u1",
    });
    expect(principalFromClaims({ scope: "api:write" })).toBeNull();
  });
});
