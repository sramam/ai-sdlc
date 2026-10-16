# Spike, October 2026: evidence

The per-item evidence of [spike-2026-10.md](spike-2026-10.md), where the verdicts, recommended defaults, corrections and addendum live; item numbers are its § _Verdicts_ rows.

### 1. TanStack Start on workerd

Doc: [Workers framework guide: TanStack Start](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
— `cloudflare({ viteEnvironment: { name: "ssr" } })` before `tanstackStart()`;
`wrangler.jsonc` `main: "@tanstack/react-start/server-entry"`,
`compatibility_flags: ["nodejs_compat"]`; bindings via
`import { env } from "cloudflare:workers"`.

```
$ npx vite build                      # client + ssr environments; writes dist/server/wrangler.json
dist/server/index.js  748.29 kB │ gzip: 156.09 kB
$ npx wrangler dev --config dist/server/wrangler.json --port 8787 --ip 127.0.0.1
$ curl -s http://127.0.0.1:8787/health
{"ok":true,"runtime":"Cloudflare-Workers"}
$ curl -s http://127.0.0.1:8787/ | grep -o '<h1[^>]*>[^<]*</h1>'
<h1 data-testid="greeting">Hello, Workers</h1>          # loader → createServerFn → port function, SSR in workerd
```

`vite dev` also runs SSR in workerd (`/health` answered `"runtime":"Cloudflare-Workers"`
and `/notes` read the database through Hyperdrive on port 3101).

**The server function was reached through SSR, not over the client RPC path**
(`/_serverFn/<id>`); a browser test would exercise that.

### 2–3. Drizzle and Prisma through Hyperdrive

Docs: [Hyperdrive + Drizzle](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/)
(node-postgres; _"Pairing Drizzle ORM with the Postgres.js driver over Hyperdrive
is not currently supported"_; a new client per request),
[Hyperdrive + Prisma](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/prisma-orm/)
(still the Prisma 6 shape: `prisma-client-js` + `previewFeatures = ["driverAdapters"]`),
[Prisma v7 on Cloudflare](https://www.prisma.io/docs/orm/prisma-client/deployment/edge/deploy-to-cloudflare)
(`provider = "prisma-client"`, `@prisma/adapter-pg`, client per request),
[Prisma generators](https://www.prisma.io/docs/orm/prisma-schema/overview/generators)
(`runtime`: `workerd`, alias `cloudflare`).

```
# Drizzle (pg Client per request, drizzle(client))
$ curl -s http://127.0.0.1:8787/notes | grep -o '<ul[^>]*>.*</ul>'
<ul data-testid="notes"><li>second</li><li>first note from migration check</li></ul>

# Prisma 7.10.1 (prisma-client generator, runtime "workerd", PrismaPg adapter)
$ curl -s http://127.0.0.1:8788/notes | grep -o '<ul[^>]*>.*</ul>'
<ul data-testid="notes"><li>second</li><li>first note from migration check</li></ul>
```

Size, from `wrangler deploy --dry-run --config dist/server/wrangler.json`:

| build                             | Total Upload | gzip      |
| --------------------------------- | ------------ | --------- |
| TanStack Start, no database       | 1,085 KiB    | 237 KiB   |
| + Drizzle + pg                    | 1,422 KiB    | 307 KiB   |
| + Drizzle + pg + Better Auth      | 2,888 KiB    | 612 KiB   |
| + Prisma 7 + adapter-pg (no auth) | 4,975 KiB    | 1,497 KiB |

First request after `wrangler dev` became ready (local, three trials each; the
second request ~4–6 ms for both):

```
app (Drizzle)  first: 200 0.0366  0.0260  0.0242 s
app-prisma     first: 200 0.0755  0.0606  0.0670 s
```

Local first-request time is not production cold start. The production limits
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)):
**64 MiB uncompressed, "no compressed size limit"**, and global scope must
execute within **1 second**. Prisma's v7 Cloudflare page still cites a 3 MB
free-plan limit, which the limits page no longer states. Either ORM fits; the
difference is cold start and headroom.

Prisma notes: npm's `latest` tag for `prisma` was `8.0.0-rc.23` on the day, so
pin `7.x` explicitly; pnpm blocks `@prisma/engines` and `prisma` install
scripts until approved, and `prisma generate` worked regardless.

### 4. Hyperdrive's local connection string

Doc: [Hyperdrive local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)
— `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING_NAME>`, or
`localConnectionString` in the Wrangler config; _"the environment variable takes
precedence"_; not used by `wrangler dev --remote`.

```
Found a non-empty CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE variable for binding.
Hyperdrive will connect to this database during local development.
env.HYPERDRIVE (00000000000000000000000000000000)      Hyperdrive Config         local
```

**Trap: it refuses a URL without a password**, and localdb prints one without:

```
"message": "You must provide a password - e.g. 'user:password@database.example.com:port/databasename' ",
"path": [ "workers", 0, "hyperdrives", "HYPERDRIVE" ]
```

PGlite ignores the password, so `postgresql://postgres:localdb@127.0.0.1:<port>/postgres?sslmode=disable`
works. The journeys adapter adds one (`withPassword`).

### 5. A migration through `pnpm db:local migrate`

`sdlc.config.json` (the starter's own, plus):
`{"localdb":{"databases":[{"name":"app","migrate":"pnpm --dir app exec drizzle-kit migrate"}]}}`

```
$ pnpm db:local start
ok    app: running (pid 22690) — postgresql://postgres@127.0.0.1:55267/postgres?sslmode=disable
$ pnpm db:local migrate
ok    app: snapshot pre-migrate-20261016-062420-058 (4.3 MB, taken while running)
[✓] migrations applied successfully!ok    app: migrated in 499ms (pnpm --dir app exec drizzle-kit migrate)
$ DATABASE_URL=… node tooling/localdb/src/wire.mts "select * from drizzle.__drizzle_migrations"
{"id":"1","hash":"dd61a3c4…","created_at":"1792131829157"}
```

The rows were then read back through the Worker (§ 2). Prisma the same way, with
`"migrate": "pnpm --dir app-prisma exec prisma migrate deploy"`:
`All migrations have been successfully applied. ok pdb: migrated in 510ms`.

A config holding only `localdb` was refused (`branches: required`, `dirs:
required` …): the loader requires the whole file, so a project adds the block
to its existing `sdlc.config.json`.

### 6. Better Auth email OTP on Workers

Docs: [Better Auth + TanStack Start](https://www.better-auth.com/docs/integrations/tanstack)
(a `src/routes/api/auth/$.ts` server route calling `auth.handler(request)`),
[Drizzle adapter](https://www.better-auth.com/docs/adapters/drizzle)
(`@better-auth/drizzle-adapter`; schema from `npx auth@latest generate`),
[Email OTP](https://www.better-auth.com/docs/plugins/email-otp)
(`POST /email-otp/send-verification-otp`, `POST /sign-in/email-otp`, `storeOTP`).

```
$ curl -s -X POST …/api/auth/email-otp/send-verification-otp -H 'origin: http://127.0.0.1:8787' \
    -d '{"email":"a@example.test","type":"sign-in"}'
{"success":true}
$ curl -s -c jar.txt -X POST …/api/auth/sign-in/email-otp -d '{"email":"a@example.test","otp":"018768"}'
{"token":"n9lF…","user":{"email":"a@example.test","emailVerified":true,…}}
$ curl -s -b jar.txt …/api/auth/get-session
{"session":{"expiresAt":"2026-10-23T06:28:17.945Z",…,"userAgent":"curl/8.7.1",…},"user":{…}}
# a foreign Origin:
send-otp with foreign origin: 403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}
```

- **Built per request**, because its database is a per-request client. No
  blocker found.
- **Schema generation** ran with `pnpm dlx auth@latest generate --config auth.cli.ts`,
  against an instance built on `drizzle.mock()`; the auth factory therefore has
  no `cloudflare:` import. Better Auth also logs `Drizzle schema mismatch`
  at request time when the tables are missing.
- **Sessions are in Postgres**, so they are revocable (tech-stack.md's rule).
- **Not tested:** MFA, passkeys, and CPU on the free plan (10 ms per request;
  the OTP path is encryption, not password hashing).

### 7. OpenTelemetry

Docs: [Exporting OpenTelemetry data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/),
[OpenTelemetry export (Wrangler)](https://developers.cloudflare.com/workers/observability/opentelemetry-export/),
[Traces](https://developers.cloudflare.com/workers/observability/traces/),
[Custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/).

What Cloudflare offers:

- Traces and logs exported over **OTLP (JSON, not protobuf)** to a destination
  created in the dashboard and named in `observability.traces.destinations` /
  `observability.logs.destinations`; `head_sampling_rate`; `persist: false` to
  export without storing. Metrics cannot be exported. Listed destinations include
  Honeycomb, Grafana Cloud, Axiom, SigNoz, Datadog, Sentry.
- **Automatic** spans for the handler, outbound `fetch` and bindings; tracing is
  "early beta" and off unless `observability.traces.enabled`.
- **Custom spans** via `tracing` from `cloudflare:workers`: `enterSpan`,
  `startActiveSpan`, `startSpan`, `getActiveSpan`, `setAttribute(s)`,
  `recordException`. **Not yet:** `setStatus`, `spanContext()` (trace/span IDs).
  `@opentelemetry/api` is not mentioned.

Under local workerd, `wrangler dev` stores spans and answers SQL:

```
$ curl -s -X POST http://127.0.0.1:8795/cdn-cgi/local/explorer/api/local/observability/query \
    -d '{"sql":"SELECT name, json(attributes) FROM spans WHERE parent_id IS NOT NULL"}'
["greet","{\"app.capability\":\"greet\",\"app.caller.role\":\"anonymous\",\"app.outcome\":\"ok\"}"],
["hyperdrive_connect",null],
["note.list","{\"app.capability\":\"note.list\",\"app.outcome\":\"ok\"}"], …
```

The recipe's span helper (`inSpan` + `workersTracer`) produced the child spans;
`hyperdrive_connect` is automatic, individual queries are not. Delivery to an
OTLP backend was **not tested** (no account).

### 8–13. Workers constraints

- **8. Long requests** (docs: [limits](https://developers.cloudflare.com/workers/platform/limits/)):
  CPU per request 10 ms free, 30 s default and 5 min maximum paid; 6 simultaneous
  outgoing connections; 128 MB per isolate. Not exercised.
- **9. Filesystem and Node API.** Under `nodejs_compat` (date 2026-10-01) a probe
  route returned:
  `{"writeTmp":"x","readRepoFile":"THROWS: Error: no such file or directory, …","processEnvHasSecret":"string"}`.
  So: the host's disk is unreachable, **`/tmp` is writable, in memory and per
  request** ([node:fs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)),
  and vars and secrets appear in `process.env` (date ≥ 2025-04-01,
  [environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)).
  `pg` ran under `nodejs_compat`. Consequence: a Worker cannot write the journeys
  outbox, so the capture transport prints a line and the adapter writes it.
- **10. Smoke-test the built Worker.** The current TanStack docs (via search;
  the docs pages returned 404 to the fetcher) name `createServerFn().inputValidator()`.
  The installed 1.169.2 has only `.validator()`. **`vite build` succeeded**, and
  the Worker answered every route with
  `{"status":500,…,"message":"HTTPError"}` / `TypeError: createServerFn(...).inputValidator is not a function`.
  `tsc --noEmit` caught it (`Property 'inputValidator' does not exist`). The rule
  stands, and typecheck belongs before the build.
- **11. Bundle size and cold start.** § 2–3.
- **12. Database connections through Hyperdrive.** Every query went through
  the binding. Locally Hyperdrive connects straight to the database, so its
  pooling and caching were **not** exercised.
- **13. Bindings per environment.** Doc: [Vite plugin, Cloudflare environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)
  — `CLOUDFLARE_ENV` at dev or build time; it _"will have no effect"_ on `wrangler deploy`.

  ```
  $ CLOUDFLARE_ENV=staging npx vite build
  spike-app-staging spike-app {"APP_ENV":"staging",…} [{"binding":"HYPERDRIVE","id":"2222…"}] staging
  $ npx wrangler deploy --dry-run --config dist/server/wrangler.json
  env.HYPERDRIVE (22222222222222222222222222222222)  Hyperdrive Config
  env.APP_ENV ("staging")                            Environment Variable
  ```

  `vars` are not inherited by named environments; each repeats them. The env
  schema then refused, by name: capture on staging, a missing Hyperdrive binding,
  and an undeclared `APP_ENV`.

### 14. Preview URLs

Doc: [Previews](https://developers.cloudflare.com/workers/configuration/previews/)
— `wrangler versions upload [--preview-alias <alias>]` returns a version URL
(`<prefix>-<worker>.<subdomain>.workers.dev`) without deploying; not generated
for Workers with Durable Objects; logs not visible through Workers Logs or tail.
A version URL _"uses that Worker version's existing configuration and resources
instead of creating a separate environment"_. **So a preview uploaded to the
`dev` Worker uses dev's Hyperdrive and database**, which environments.md
forbids. A preview with its own database needs its own Hyperdrive config in the
uploaded version (and a branch or a seeded throwaway behind it); not tested.

### Found on the way: localdb under concurrent connections

Ten concurrent requests, three rounds, through Hyperdrive to localdb:
`21 × 200, 9 × 500`, each `error: portal "" does not exist`. localdb's server
multiplexes connections onto one PGlite session (`maxConnections: 100`), and
the unnamed portal of the extended protocol is per session, reached through
the Worker's one-client-per-request rule. Sequential requests never failed.
Real Postgres (and so a deployed Hyperdrive) is unaffected.

It matters to journeys: a page whose loaders, or a browser's parallel requests,
hit the database at once will fail intermittently. Suggested fix in
`tooling/localdb` (not made in this spike): serialize **whole extended-protocol
exchanges** per connection — hold the session from the first `Parse`/`Bind`
until `Sync`'s `ReadyForQuery` (and across an open transaction) — rather than
interleaving messages. Made since: `SessionLock` in
`tooling/localdb/src/socket.mts`, covered by
`tooling/localdb/src/concurrency.test.ts`; what still remains shared is stated
in environments.md § _Local_.

### The recipes, re-assembled

Assembled from the repository into a fresh project (`tooling` linked, a pnpm
workspace with `apps/web`), then:

```
build 0 · tsc 0 · apps/web vitest: 3 files, 10 tests passed · e2e/stack.test.ts: 4 passed
$ node drive.mts          # startHost(adapter) from tooling/journeys, then requests
journeys[tanstack-workers]: ready at http://localhost:3182/health (+4.7s)
GET / -> <h1 data-testid="greeting">Hello, Workers</h1>
GET /notes -> <ul data-testid="notes"></ul>
send OTP -> 200 {"success":true}
captured to outbox -> Your sign-in code otp 121592
sign in -> 200
session -> 200 j@example.test
control /reset -> 200
session after reset -> 200 null
journeys[tanstack-workers]: control channel closed — teardown complete (+7.6s)
```

`eslint docs/kit/recipes` and `prettier --check docs/kit/recipes` pass with the
repository's configuration.
