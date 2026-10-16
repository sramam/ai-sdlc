# Recipe: `api-bindings`

The port's three default bindings, rendered from the manifest
([`api/`](../api/)): an **HTTP API** with its **OpenAPI** document, an **MCP
server**, and a typed **SDK**. Plus caller resolution for each, and the pattern
check that keeps all three complete.

**The rule:** every capability in the manifest is reachable through all three,
unless the manifest's `exclusions` names a binding for it with a reason that is
a property of the mechanism ("the upload step needs the browser's file
picker"). All three are rendered from the manifest, never written by hand, so
they cannot drift from it or from each other.

Instantiated as `packages/bindings` (`@<scope>/bindings`); `src/sdk/` can
become its own published package, since it imports nothing at runtime but
`surface.ts`. Imports of `../../api/src/…` become `@<scope>/api`.

| file                            | is                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/surface.ts`                | what the bindings share: path and tool name from a capability name, exclusions, refusal → HTTP status        |
| `src/http/router.ts`            | `createHttpHandler`: a `(Request) => Promise<Response>`                                                      |
| `src/http/openapi.ts`           | `renderOpenApi`: OpenAPI 3.1 with schemas from `z.toJSONSchema`; committed as `openapi.json`                 |
| `src/mcp/server.ts`             | `mcpServer` (one caller's tools) and `createMcpEndpoint` (Streamable HTTP, both protocol eras)               |
| `src/sdk/client.ts`             | `createClient<typeof manifest, typeof exclusions>()`: a typed proxy over `fetch`                             |
| `src/auth/principal.ts`         | credential → `Caller`: bearer or same-origin cookie, the relationship re-read live, the credential's ceiling |
| `src/auth/better-auth.ts`       | Better Auth's session, API-key (`@better-auth/api-key`) and MCP OAuth (`@better-auth/mcp`) verification      |
| `src/bindings.pattern-check.ts` | the pattern check; `*.test.ts` runs it against what each binding actually renders, then trips it both ways   |
| `src/bindings.contract.test.ts` | one scenario through `invoke`, HTTP, SDK and MCP against PGlite: identical transcripts                       |

## Decisions

**Every call is `POST <base>/<entity>/<verb>` with a JSON body, reads
included.** Inputs are Zod objects of any shape, which a query string cannot
carry without loss (numbers become strings, arrays and nesting need a
convention). Search terms in a URL land in access logs. And requiring
`Content-Type: application/json` on every call means a cross-site page cannot
send one without a CORS preflight, which is the CSRF defence for cookie
callers. Reads are marked `x-effect: read` in OpenAPI and `readOnlyHint` in
MCP. The cost: no HTTP caching of reads, which tenant-scoped answers should not
get anyway (`cache-control: no-store`).

**Refusal → status.** `INVALID` 422 when it names a field (the body parsed, a
value is wrong) and 400 when it does not; `FORBIDDEN` 403; `NOT_FOUND` 404;
`CONFLICT` 409; `UNAVAILABLE` 503. The body is the refusal itself. No
credential is 401 with a `Bearer` challenge; a rate limit is 429; a defect is
500 with nothing about it in the body.

**The SDK is a typed proxy, not generated source.** Its types are computed from
`typeof manifest` (`capability()` keeps each name as a literal, the manifest is
`as const`), so a new capability is a method at the next compile, with no file
to regenerate and nothing to go stale. Refusals are returned, defects thrown,
as in the port. The cost: a consumer outside the monorepo needs the declaration
files built from it (and `zod` for the types); a non-TypeScript consumer uses
`openapi.json`.

**MCP: the official SDK v2, `@modelcontextprotocol/server` 2.2.0**, not v1's
`@modelcontextprotocol/sdk` and not Cloudflare's `agents`. v2 is the stable
line for the 2026-07-28 spec, its `createMcpHandler` is a web-standard
`fetch` handler with a `workerd` build, and its default `legacy: "stateless"`
also serves 2025-era clients. `agents` (0.28, pre-1.0) wraps the same SDK and
needs `cloudflare:` modules, so it cannot run under Vitest in Node. The
low-level `Server` is used rather than `registerTool`, which validates
arguments itself: the port must be the one validator, or `INVALID` with a field
would differ between MCP and every other binding. Tool names use `_`
(`project_create`), because model APIs that clients forward tools to reject
dots.

**Versions** (2026-10-16): MCP 2.2.0 (2026-09-28) is pinned at least two weeks
old. Better Auth is 1.7.9 (2026-10-15), the version every recipe here pins: a
project uses one, and the app recipe's 1.7.10 was younger than the starter's
one-day `minimumReleaseAge` when the recipes were aligned. 1.7.10 only fixed
Google One Tap and `@better-auth/oauth-provider` edge cases. `@better-auth/utils`,
`better-call` and `@better-auth/oauth-provider` are direct dependencies so
pnpm resolves the plugins' peers to the same copies: without them it installed
two `@better-auth/core`s and the plugin types stopped matching.

## Caller resolution

Nothing accepts a tenant or a role from a request; a credential proves who is
calling, and the relationship comes from the database.

| binding           | credential                                     | how it becomes a `Caller`                                                                                          |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| HTTP from the app | session cookie, **only from the app's origin** | `getSession`, then the session's active relationship                                                               |
| HTTP, SDK         | `Authorization: Bearer <API key>`              | `verifyApiKey`; the key's `metadata.relationshipId`, set server-side at creation, re-checked live                  |
| MCP               | OAuth 2.1 access token, audience = `/mcp`      | `@better-auth/mcp` verifies signature, issuer, audience, expiry; `sub` + `relationship_id` claim → re-checked live |

A bearer header is used alone: a bad key never falls back to a cookie. Each
credential has a **ceiling** (`api:read`, `api:write`): a read-only key held
by an admin still cannot write, checked before the port is reached. An MCP
token minted for `/mcp` is refused by the HTTP API and the reverse, because
each verifies its own audience. A key store that cannot be asked is 503, never 401.

**Better Auth's API-key plugin (1.7.7 through 1.7.9) defaults to 10 requests per key per day**
(measured). Configure `rateLimit` deliberately, or rate-limit in the binding
(`limit`) and turn the plugin's off. Metadata needs `enableMetadata: true`.

## Mount it (TanStack Start on Workers)

```ts
// src/routes/api/$.ts
const http = createHttpHandler({
  manifest,
  exclusions,
  basePath: "/api",
  authenticate: (r) =>
    authenticate(r, {
      appOrigin: env.APP_ORIGIN,
      ...betterAuthVerifiers(auth),
      activeRelationship,
    }),
  deps: () => ({ db, authz, around: (n, f) => inSpan(tracer, n, { "app.capability": n }, f) }),
  limit: (key) => env.API_RATE_LIMIT.limit({ key }).then((r) => r.success),
});
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: { POST: ({ request }) => http(request), GET: ({ request }) => http(request) },
  },
});

// src/routes/mcp.ts
const mcp = mcpAuth(
  { issuer: `${origin}/api/auth`, audience: `${origin}/mcp`, jwksUrl: `${origin}/api/auth/jwks` },
  { activeRelationship },
  createMcpEndpoint({ manifest, exclusions, info: { name: "app", version }, deps }),
);
```

A sketch, not compiled here: the per-request database and auth instance come
from `app-tanstack-workers`. The authorization server is Better Auth with
`jwt()` and `mcp({ resource: "<origin>/mcp", loginPage, consentPage })`, plus
`cimd()` for client metadata documents; the consent screen chooses the
relationship and adds it as the `relationship_id` claim.

## Run the tests

```bash
pnpm install && pnpm test          # 46 tests; PGlite and MCP in process, no network
pnpm openapi:write                 # after a manifest change; the test fails until it is run
```

Verified 2026-10-16 by `pnpm recipes:check --only api,api-bindings` (Node
24.18.0): typecheck clean, all pass. **Proved by tripping**: dropping
`project.rename` from the MCP tool list fails the pattern check with
"missing from mcp, and no exclusion says why"; dropping `field` from MCP
refusals fails the MCP contract run; the empty placeholder `openapi.json`
failed `OPENAPI-002` until written. The pattern check's own suite trips
every rule with made-up surfaces and exclusions.

## Not verified

- **On workerd.** Everything here is web-standard and the MCP package ships a
  `workerd` build, but nothing in this recipe ran under `wrangler dev`.
- **The OAuth flow itself** (authorize, consent, token, CIMD). The test signs
  tokens with a local key and serves its JWKS through a stubbed `fetch`, so it
  exercises Better Auth's verifier and our token → `Caller` step, not the
  issuing side.
- **The session path against Better Auth.** `getSession` is a one-line call
  verified by `app-tanstack-workers`; here it is stubbed, and what is tested is
  the origin rule around it.
- A real MCP client (Claude, an IDE) against the endpoint; the tests use the
  SDK's own client, over the 2025-era handshake it defaults to.
