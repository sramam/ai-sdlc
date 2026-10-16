# Recipe: `app-tanstack-workers`

A minimal TanStack Start app on Cloudflare Workers: an SSR route whose loader
calls a server function, a server function as the **binding** over a port
function, a database read through Hyperdrive, Better Auth (email OTP) mounted
as a server route, and `wrangler.jsonc` with local, dev, staging and production.
Proven in the October 2026 platform spike ([../../spike-2026-10.md](../../spike-2026-10.md)),
by assembling it from these directories and running it.

It depends on four sibling recipes, instantiated **into** it:

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
| `vite.config.ts`                              | `cloudflare({ viteEnvironment: { name: "ssr" } })` **first**, then `tanstackStart()`, then React        |
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

```bash
pnpm install
pnpm exec drizzle-kit generate --name=init     # from src/db/schema.ts
pnpm db:local start && pnpm db:local migrate   # this checkout's PGlite (repo root)
pnpm exec vite build
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$(pnpm -s db:local url | sed 's#postgres@#postgres:localdb@#')" \
  pnpm exec wrangler dev --config dist/server/wrangler.json
```

`vite dev` also runs SSR in workerd (with the same variable set), but smoke-test
the **built** Worker: it is what deploys.

## Traps the spike hit

- **`createServerFn().validator(...)`, not `.inputValidator(...)`.** The current
  docs show `inputValidator`; `@tanstack/react-start` 1.169.2 has only
  `validator`. `vite build` succeeds either way and the Worker then answers
  every route with 500 — `tsc --noEmit` is what catches it. Run it before
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
- `pnpm.onlyBuiltDependencies` belongs in the workspace root (or
  `pnpm-workspace.yaml`); it is in this `package.json` only so the recipe
  installs on its own.

## Not here

The email package (deployed mail throws `MAIL-001`), the session-to-`Caller`
resolver, authorization, R2 and Queues bindings, `/api/health` with the
database-branch check, and the promote scripts.
