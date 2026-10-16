// Caller resolution for the HTTP API, the SDK and MCP: the security core.
//
// A request proves WHO is calling (a session cookie, an API key, an OAuth
// access token) and nothing else. The tenant and role come from the person's
// relationship, read from the database by `activeRelationship`; no header,
// query or body can name them. Every path ends in the port's `resolveCaller`.
//
// Each credential also carries a CEILING: the scopes it was issued with. A
// call needs both the caller's authority (the port's authorize step) and the
// credential's scope, so a read-only key held by an admin still cannot write.
import { resolveCaller, type ActiveRelationship, type Caller } from "../../../api/src/caller";
import type { Effect } from "../../../api/src/capability";
import { refuse, type Refusal } from "../../../api/src/refusal";

export type Scope = "api:read" | "api:write";
export const SCOPES: readonly Scope[] = ["api:read", "api:write"];

/** A verified credential. `relationshipId` was bound when it was issued, server-side. */
export type Principal = {
  readonly userId: string;
  readonly via: "session" | "api-key" | "oauth";
  /** `all` for a first-party session: the person's own authority, no narrower. */
  readonly scopes: readonly Scope[] | "all";
  readonly relationshipId?: string;
  /** Rate-limit key: the API key's id, the OAuth client, or the user. */
  readonly rateKey: string;
};

/** What a binding needs to call the port: a Caller, and the credential's ceiling. */
export type Authenticated = {
  readonly caller: Caller;
  readonly scopes: readonly Scope[] | "all";
  readonly rateKey: string;
};

/** Three answers, never two: a principal, no valid credential, or could not ask. */
export type Verified = Principal | null | "unavailable";

export type Verifiers = {
  /** The app's own origin. A cookie is accepted only on a request from it. */
  appOrigin: string;
  /** The auth library's session lookup (Better Auth: `auth.api.getSession`). */
  session(headers: Headers): Promise<{ userId: string } | null>;
  /** An API key, presented as `Authorization: Bearer <key>`. */
  apiKey(key: string): Promise<Verified>;
  /**
   * The relationship to act in, read from the database: for a session its
   * active one, for a key or token the one bound at issue. Must return null
   * when that relationship no longer belongs to the user (revoked access).
   */
  activeRelationship(p: Principal): Promise<ActiveRelationship | null>;
};

/**
 * HTTP API and SDK. `null` means no valid credential (401); a Refusal means
 * authenticated but not able to act (403), or could not ask (503).
 *
 * - `Authorization: Bearer` present → that credential only. A bad token never
 *   falls back to a cookie the browser also happened to send.
 * - otherwise a session cookie, only from the app's own origin: a cookie is
 *   ambient, so a cross-site page could otherwise spend it (CSRF). The router
 *   also requires `Content-Type: application/json`, which a cross-site form
 *   cannot send without a preflight.
 */
export async function authenticate(
  request: Request,
  v: Verifiers,
): Promise<Authenticated | Refusal | null> {
  const header = request.headers.get("authorization");
  let principal: Verified;
  if (header !== null) {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return null;
    principal = await v.apiKey(m[1]!);
  } else {
    if (!sameOrigin(request, v.appOrigin)) return null;
    const s = await v.session(request.headers);
    principal = s
      ? { userId: s.userId, via: "session", scopes: "all", rateKey: `user:${s.userId}` }
      : null;
  }
  if (principal === "unavailable") return refuse("UNAVAILABLE", "Could not verify the credential.");
  if (principal === null) return null;
  return toAuthenticated(principal, v);
}

export async function toAuthenticated(
  p: Principal,
  v: Pick<Verifiers, "activeRelationship">,
): Promise<Authenticated | Refusal> {
  const caller = resolveCaller({ userId: p.userId }, await v.activeRelationship(p));
  if ("ok" in caller) return caller;
  return { caller, scopes: p.scopes, rateKey: p.rateKey };
}

/** The credential's ceiling. A write needs `api:write`; a read needs either. */
export function withinScope(scopes: Authenticated["scopes"], effect: Effect): boolean {
  if (scopes === "all") return true;
  return effect === "write" ? scopes.includes("api:write") : scopes.length > 0;
}

/** Keep only scopes this API defines; an unknown one grants nothing. */
export function knownScopes(granted: Iterable<string>): Scope[] {
  const set = new Set(granted);
  return SCOPES.filter((s) => set.has(s));
}

/**
 * MCP: the claims of an OAuth access token the resource server has ALREADY
 * verified (signature, issuer, audience = this MCP endpoint, expiry; see
 * `better-auth.ts`). `sub` is the user; `relationship_id` is a claim our
 * authorization server adds at consent, re-checked live by `activeRelationship`.
 */
export function principalFromClaims(claims: Record<string, unknown>): Principal | null {
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  const scope = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  const client = typeof claims.client_id === "string" ? claims.client_id : claims.azp;
  return {
    userId: claims.sub,
    via: "oauth",
    scopes: knownScopes(scope),
    relationshipId: typeof claims.relationship_id === "string" ? claims.relationship_id : undefined,
    rateKey: typeof client === "string" ? `client:${client}:${claims.sub}` : `user:${claims.sub}`,
  };
}

function sameOrigin(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === appOrigin;
  // Browsers send Sec-Fetch-Site on every fetch; without Origin, only a same-origin one counts.
  return request.headers.get("sec-fetch-site") === "same-origin";
}
