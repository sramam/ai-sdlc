# Recipes

Reference implementations of the packages most projects need. **Not wired into
the build**: the foundation items instantiate the ones `/kickoff` chose into
`apps/` and `packages/`, and the project owns them from then on
(docs/kit/starter-repo.md).

Built from the October 2026 platform spike ([../spike-2026-10.md](../spike-2026-10.md)),
which assembled them into a scratch project and ran them on workerd:

| recipe                                           | is                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [`app-tanstack-workers/`](app-tanstack-workers/) | TanStack Start on Workers: SSR route, server function over a port, Better Auth, four environments          |
| [`db-drizzle/`](db-drizzle/)                     | Drizzle + `pg` through Hyperdrive, per request; migrations by `pnpm db:local migrate` (default)            |
| [`db-prisma/`](db-prisma/)                       | Prisma 7 + `@prisma/adapter-pg` through Hyperdrive (the alternative)                                       |
| [`env-schema/`](env-schema/)                     | one Zod schema for variables and bindings, with allow-listed environments                                  |
| [`telemetry/`](telemetry/)                       | span helper, attribute registry, Workers-native tracer, in-memory test exporter                            |
| [`journeys-adapter/`](journeys-adapter/)         | a `StackAdapter`: built Worker under `wrangler dev`, localdb through Hyperdrive, outbox capture            |
| [`api/`](api/)                                   | the port: `Caller`, `Refusal`, `invoke` (validate, scope, authorize, run), manifest, PGlite contract suite |
| [`ui/`](ui/)                                     | shadcn on Base UI, tokens, shell with ⌘K and role switcher, the five screen patterns and four states       |
| [`authz-oso/`](authz-oso/)                       | `@scope/authz` over Oso: Polar policy with tests, local authorization from Postgres, matrix test           |
| [`authz-spicedb/`](authz-spicedb/)               | `@scope/authz` over SpiceDB's HTTP API, relationships through an outbox, matrix test                       |
| [`llm-openrouter/`](llm-openrouter/)             | `@scope/llm`: routing by data class (ZDR for real data), model per role, cost caps, recordings             |
| [`dev-session/`](dev-session/)                   | `pnpm dev:session`: a real passwordless sign-in for a seeded account, for curl and Playwright              |
| [`api-bindings/`](api-bindings/)                 | the manifest as an HTTP API with OpenAPI, an MCP server and a typed SDK; caller resolution per binding     |

The second group was built after the spike, against current vendor docs and,
where one could run, the vendor's local engine; each README says what was run
and what was not ([../spike-2026-10.md](../spike-2026-10.md) § _Addendum_).

`pnpm recipes:check` (`scripts/recipes-check.mts`) builds each recipe in a
scratch workspace (install, typecheck, its own tests) and answers _pass_,
_fail_, _could not run_ or _not checked_ per recipe, with the reason. It needs
the network and is run by hand when a recipe changes; the authorization
recipes report _could not run_ unless their engine is started
([../starter-repo.md](../starter-repo.md)).
