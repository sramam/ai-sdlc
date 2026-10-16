// What only the MCP binding does: the tool list, scope ceilings, and the HTTP
// endpoint behind OAuth (token → Caller). The answers are the contract suite's.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { manifest } from "../../../api/src/manifest";
import { mcpAuth } from "../auth/better-auth";
import { mcpClient, mcpOptions, newWorld, verifiers } from "../test-support";
import { createMcpEndpoint } from "./server";

describe("tools/list", () => {
  it("one tool per capability: schema from Zod, description from summary, read-only from effect", async () => {
    const client = await mcpClient(await newWorld(), "key-alice");
    const { tools } = await client.listTools();
    expect(tools.map((t) => [t.name, t.description, t.annotations?.readOnlyHint])).toEqual(
      manifest.map((c) => [c.name.replace(".", "_"), c.summary, c.effect === "read"]),
    );
    const create = tools.find((t) => t.name === "project_create")!;
    expect(create.inputSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string", minLength: 2 } },
      additionalProperties: false,
    });
    expect(create.outputSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
    });
  });
});

describe("tools/call", () => {
  it("a read-only token cannot call a write tool", async () => {
    const w = await newWorld();
    const client = await mcpClient(w, "key-alice-ro");
    const r = await client.callTool({ name: "project_create", arguments: { name: "Roof" } });
    expect([r.isError, r.structuredContent]).toEqual([
      true,
      { ok: false, code: "FORBIDDEN", detail: "This token's scope does not allow that." },
    ]);
    expect(w.authz.asked).toEqual([]);
  });

  it("an unknown tool is a NOT_FOUND tool error", async () => {
    const client = await mcpClient(await newWorld(), "key-alice");
    const r = await client.callTool({ name: "project_delete", arguments: {} });
    expect(r.structuredContent).toMatchObject({ code: "NOT_FOUND" });
  });
});

// The endpoint as an app mounts it: Better Auth's verifier in front, our
// token → Caller step, then the MCP handler. The JWKS is served by a stubbed
// fetch, standing in for Better Auth's `/jwks` (its `mcp()` plugin signs the
// tokens in production; that flow is not run here: README § Not verified).
describe("the HTTP endpoint, behind OAuth", () => {
  // Better Auth refuses a non-HTTPS resource outside loopback.
  const ORIGIN = "https://app.test";
  const issuer = `${ORIGIN}/api/auth`;
  const audience = `${ORIGIN}/mcp`;
  let sign: (claims: Record<string, unknown>, aud?: string) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA", use: "sig" };
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (u: string | URL | Request, init?: RequestInit) =>
      String(u) === `${issuer}/jwks` ? Response.json({ keys: [jwk] }) : real(u, init),
    );
    sign = (claims, aud = audience) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
  });
  afterAll(() => vi.unstubAllGlobals());

  const endpoint = async () => {
    const w = await newWorld();
    return mcpAuth(
      { issuer, audience, jwksUrl: `${issuer}/jwks` },
      verifiers(),
      createMcpEndpoint(mcpOptions(w)),
    );
  };
  const connect = async (handler: (r: Request) => Promise<Response>, token: string) => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(audience), {
        fetch: (u, init) =>
          handler(
            new Request(u, {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers)),
                authorization: `Bearer ${token}`,
              },
            }),
          ),
      }),
    );
    return client;
  };

  it("no token: 401 with the RFC 9728 challenge an MCP client discovers from", async () => {
    const res = await (await endpoint())(new Request(audience, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("a token for another resource is refused (audience binding)", async () => {
    const t = await sign(
      { sub: "u-alice", scope: "api:read api:write", relationship_id: "rel-alice" },
      `${ORIGIN}/other`,
    );
    const res = await (
      await endpoint()
    )(
      new Request(audience, {
        method: "POST",
        headers: { authorization: `Bearer ${t}` },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("a token whose relationship is not the user's is 403 before any MCP message", async () => {
    const t = await sign({ sub: "u-alice", scope: "api:write", relationship_id: "rel-bruno" });
    const res = await (
      await endpoint()
    )(
      new Request(audience, {
        method: "POST",
        headers: { authorization: `Bearer ${t}` },
        body: "{}",
      }),
    );
    expect([res.status, (await res.json()).code]).toEqual([403, "FORBIDDEN"]);
  });

  it("a valid token acts as its user, in its relationship, within its scope", async () => {
    const handler = await endpoint();
    const rw = await connect(
      handler,
      await sign({
        sub: "u-alice",
        scope: "openid api:read api:write",
        relationship_id: "rel-alice",
        client_id: "c1",
      }),
    );
    const made = await rw.callTool({ name: "project_create", arguments: { name: "Roof" } });
    expect(made.structuredContent).toMatchObject({ ok: true, id: expect.any(String) });

    const ro = await connect(
      handler,
      await sign({ sub: "u-alice", scope: "api:read", relationship_id: "rel-alice" }),
    );
    const refused = await ro.callTool({ name: "project_create", arguments: { name: "Walls" } });
    expect(refused.structuredContent).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});
