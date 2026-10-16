# Recipes

Reference implementations of the packages most projects need. **Not wired into
the build**: the foundation items instantiate the ones `/kickoff` chose into
`apps/` and `packages/`, and the project owns them from then on
(docs/kit/starter-repo.md).

Built from the October 2026 platform spike ([../spike-2026-10.md](../spike-2026-10.md)),
which assembled them into a scratch project and ran them on workerd:

| recipe                                           | is                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [`app-tanstack-workers/`](app-tanstack-workers/) | TanStack Start on Workers: SSR route, server function over a port, Better Auth, four environments |
| [`db-drizzle/`](db-drizzle/)                     | Drizzle + `pg` through Hyperdrive, per request; migrations by `pnpm db:local migrate` (default)   |
| [`db-prisma/`](db-prisma/)                       | Prisma 7 + `@prisma/adapter-pg` through Hyperdrive (the alternative)                              |
| [`env-schema/`](env-schema/)                     | one Zod schema for variables and bindings, with allow-listed environments                         |
| [`telemetry/`](telemetry/)                       | span helper, attribute registry, Workers-native tracer, in-memory test exporter                   |
| [`journeys-adapter/`](journeys-adapter/)         | a `StackAdapter`: built Worker under `wrangler dev`, localdb through Hyperdrive, outbox capture   |

Still planned: `api`, `ui`, `authz-oso`, `authz-spicedb`, `llm-openrouter`,
`dev-session`.
