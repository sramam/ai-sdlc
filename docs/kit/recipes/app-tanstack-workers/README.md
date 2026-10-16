# Recipe: `app-tanstack-workers`

A minimal TanStack Start app on Cloudflare Workers: an SSR route whose loader
calls a server function, a server function as the binding over a port
function, a database read through Hyperdrive, Better Auth (email OTP) mounted
as a server route, and `wrangler.jsonc` with local, dev, staging and production.
Proven in the October 2026 platform spike ([../../spike-2026-10.md](../../spike-2026-10.md)),
by assembling it from these directories and running it.

It depends on four sibling recipes, instantiated into it:

| copy                                     | to                      |
| ---------------------------------------- | ----------------------- |
| `../env-schema/src/*`                    | `src/` (`env.ts`)       |
| `../db-drizzle/src/*`                    | `src/db/`               |
| `../db-drizzle/drizzle.config.ts`        | the app root            |
| `../telemetry/src/*`                     | `src/telemetry/`        |
| `../journeys-adapter/stack.mts` (+ test) | `e2e/` at the repo root |

In a project the port (`src/port/`) moves to `packages/api`, and `db`,
`telemetry` and `env` may become packages; the imports change, nothing else.

## Layout

| file                                          | is                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `vite.config.ts`                              | `cloudflare({ viteEnvironment: { name: "ssr" } })` first, then `tanstackStart()`, then React            |
| `wrangler.jsonc`                              | `main: "@tanstack/react-start/server-entry"`, `nodejs_compat`, traces on, Hyperdrive, four environments |
| `src/routes/index.tsx`                        | SSR route; loader calls `greetFn`                                                                       |
| `src/server/greet.ts`                         | the binding: validate, resolve the Caller, open a span, call the port                                   |
| `src/port/greet.ts`                           | the port: no framework, no runtime; returns a refusal instead of throwing                               |
| `src/routes/notes.tsx`, `src/server/notes.ts` | a read through Hyperdrive (`withDb`, one client per request)                                            |
| `src/routes/api/auth/$.ts`                    | Better Auth, built per request over a per-request database client                                       |
| `src/auth.ts`, `auth.cli.ts`                  | the auth factory (no `cloudflare:` import); the CLI entry for schema generation                         |
| `src/server/env.ts`                           | the only reader of `cloudflare:workers` `env`; validates it once per isolate                            |
| `src/server/mail.ts`                          | capture transport (local only): one `EMAIL-CAPTURE {json}` line                                         |
| `src/routes/health.ts`                        | the journeys adapter's `readyPath`                                                                      |
| `vitest.config.ts`                            | Node tests, deliberately not loading `vite.config.ts` (it pulls in the Cloudflare plugin)               |

## Run it

Every command runs from the repository root; the app's own commands go
through `pnpm --filter @app/web`, which runs them in `apps/web`.

First, allow the install scripts this app needs. pnpm reads
`onlyBuiltDependencies` only from the workspace root, so it goes in the
root `pnpm-workspace.yaml` (whose starter default is `[]`), reviewed like any
change to that list ([security.md](../../security.md) § _Supply chain_):

```diff
-onlyBuiltDependencies: []
+onlyBuiltDependencies:
+  - esbuild
+  - workerd
+  - sharp
```

Merge `../db-drizzle/sdlc.config.localdb.json` into `sdlc.config.json` so
`pnpm db:local migrate` knows the app's migration command. Then:

```bash
pnpm install
pnpm --filter @app/web exec drizzle-kit generate --name=init   # from src/db/schema.ts, into apps/web/drizzle/
pnpm db:local start && pnpm db:local migrate                   # this checkout's PGlite
pnpm --filter @app/web build                                   # vite build; also writes src/routeTree.gen.ts
pnpm --filter @app/web typecheck                               # wrangler types, then tsc --noEmit
pnpm --filter @app/web test
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$(pnpm -s db:local url | sed 's#postgres@#postgres:localdb@#')" \
  pnpm --filter @app/web start:worker                          # wrangler dev on the built Worker
```

**Two generated files, treated differently.** `worker-configuration.d.ts` (the
`Env` type `tsconfig.json` loads) is written by `wrangler types` from
`wrangler.jsonc`; `typecheck` regenerates it every run, so it is gitignored
(the recipe's `.gitignore`) and can never describe a stale config.
`src/routeTree.gen.ts` is written by TanStack Router's Vite plugin on
`vite dev` and `vite build`; commit it, so a fresh clone typechecks without a
build first.

`vite dev` also runs SSR in workerd (with the same variable set), but smoke-test
the built Worker: it is what deploys.

**Verified** 2026-10-16 by `pnpm recipes:check`, which assembles this recipe with
`env-schema`, `db-drizzle` and `telemetry` in a scratch workspace whose
`pnpm-workspace.yaml` carries exactly the patch above, then runs `build`,
`typecheck` and `test` (10 pass). The database and `wrangler dev` steps were
not re-run there (they need localdb and workerd ports); the spike ran them.

## Traps the spike hit

- **`createServerFn().validator(...)`, not `.inputValidator(...)`.** The current
  docs show `inputValidator`; `@tanstack/react-start` 1.169.2 has only
  `validator`. `vite build` succeeds either way and the Worker then answers
  every route with 500; `tsc --noEmit` is what catches it. Run it before
  trusting a build; when upgrading, re-check which method exists.
- **Hyperdrive's local connection string must contain a password**
  (`You must provide a password`). localdb prints a URL without one; PGlite
  ignores the password, so add any.
- **The local string is `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`**,
  and it beats `localConnectionString` in `wrangler.jsonc`. The one in the file
  is a dead URL on purpose, so a forgotten variable fails loudly.
- **Environments are chosen at build time**: `CLOUDFLARE_ENV=staging vite build`
  writes a flattened `dist/server/wrangler.json` (name `app-staging`); then
  `wrangler deploy` with no `--env`. `vars` and bindings are not inherited by
  named environments; each repeats them.
- **Concurrent requests against localdb can fail** with `portal "" does not
exist`: localdb multiplexes connections onto one PGlite session. Real
  Postgres does not do this. See the spike report.
- **Sign-in needs `Origin` equal to `BETTER_AUTH_URL`** (403 `INVALID_ORIGIN`
  otherwise). The journeys adapter passes `--var BETTER_AUTH_URL:<appUrl>`.
- **`onlyBuiltDependencies` in this `package.json` would be ignored**: pnpm
  reads it only at the workspace root, so it lives in the root
  `pnpm-workspace.yaml` (§ _Run it_).

## Not here

The email package (deployed mail throws `MAIL-001`), the session-to-`Caller`
resolver, authorization, R2 and Queues bindings, `/api/health` with the
database-branch check, and the promote scripts.
