// The Better Auth side of caller resolution (verified against 1.7.7).
//
// | binding       | credential                     | Better Auth                                     |
// | ------------- | ------------------------------ | ----------------------------------------------- |
// | HTTP, browser | session cookie, same origin    | `auth.api.getSession({ headers })`              |
// | HTTP, SDK     | `Authorization: Bearer <key>`  | `@better-auth/api-key`: `auth.api.verifyApiKey` |
// | MCP           | OAuth 2.1 access token (JWT)   | `@better-auth/mcp`: `mcp()` issues it, and      |
// |               | audience-bound to the endpoint | `createMcpProtectedRequestHandler` verifies it  |
//
// The structural types below are the slice of `auth.api` used here, so the
// recipe does not depend on how a project's plugin list widens Better Auth's
// generics.
import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import type { Refusal } from "../../../api/src/refusal";
import { statusFor } from "../surface";
import {
  knownScopes,
  principalFromClaims,
  toAuthenticated,
  type Authenticated,
  type Principal,
  type Scope,
  type Verified,
  type Verifiers,
} from "./principal";

type ApiKeyRecord = {
  id: string;
  referenceId: string;
  permissions?: Record<string, string[]> | null;
  metadata?: Record<string, unknown> | null;
};

export type BetterAuthApi = {
  api: {
    getSession(args: { headers: Headers }): Promise<{ user: { id: string } } | null>;
    verifyApiKey(args: { body: { key: string } }): Promise<{
      valid: boolean;
      key: ApiKeyRecord | null;
    }>;
  };
};

/**
 * Session and API-key verifiers over a Better Auth instance. API keys are
 * created with `permissions: { api: ["read"] }` or `["read", "write"]` and
 * `metadata: { relationshipId }`, server-side, by a capability the person runs
 * in the app; the key itself never names a tenant.
 *
 * Configure the plugin with `enableMetadata: true` and an explicit rate limit:
 * 1.7.7's default is 10 requests per key per day (measured 2026-10-16).
 */
export function betterAuthVerifiers(auth: BetterAuthApi): Pick<Verifiers, "session" | "apiKey"> {
  return {
    async session(headers) {
      const s = await auth.api.getSession({ headers });
      return s ? { userId: s.user.id } : null;
    },
    async apiKey(key): Promise<Verified> {
      let r;
      try {
        r = await auth.api.verifyApiKey({ body: { key } });
      } catch {
        return "unavailable"; // the key store could not be asked: refuse, not "no key"
      }
      if (!r.valid || !r.key) return null;
      const rel = r.key.metadata?.relationshipId;
      return {
        userId: r.key.referenceId,
        via: "api-key",
        scopes: scopesFromPermissions(r.key.permissions),
        relationshipId: typeof rel === "string" ? rel : undefined,
        rateKey: `key:${r.key.id}`,
      } satisfies Principal;
    },
  };
}

/** `{ api: ["read"] }` → `api:read`. No `api` entry grants nothing (default deny). */
export function scopesFromPermissions(p: Record<string, string[]> | null | undefined): Scope[] {
  return knownScopes((p?.api ?? []).map((a) => `api:${a}`));
}

export type McpAuthOptions = {
  /** The authorization server's issuer (Better Auth's base URL plus its path). */
  issuer: string;
  /** This MCP endpoint's URL. A token minted for another resource is refused. */
  audience: string;
  jwksUrl: string;
};

/**
 * Wraps an MCP endpoint: verifies the bearer token (401 with the RFC 9728
 * `WWW-Authenticate` challenge when absent or invalid), turns its claims into
 * a Caller, and hands it to `serve`. A token whose relationship is gone is a
 * 403 with the refusal, before any MCP message is read.
 */
export function mcpAuth(
  opts: McpAuthOptions,
  v: Pick<Verifiers, "activeRelationship">,
  serve: (request: Request, who: Authenticated) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return createMcpProtectedRequestHandler(
    { issuer: opts.issuer, audience: opts.audience, jwksUrl: opts.jwksUrl },
    async (request, claims) => {
      const p = principalFromClaims(claims as Record<string, unknown>);
      if (!p)
        return refusalResponse({
          ok: false,
          code: "FORBIDDEN",
          detail: "The token names no user.",
        });
      const who = await toAuthenticated(p, v);
      if ("ok" in who) return refusalResponse(who);
      return serve(request, who);
    },
  );
}

function refusalResponse(r: Refusal): Response {
  return Response.json(r, { status: statusFor(r) });
}
