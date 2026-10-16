# Recipes

Reference implementations of the packages most projects need. Each is an item:
`/kickoff` records which recipes the project takes, and the foundation items
run `pnpm sdlc add <recipe>`, which copies it to the place its README names
(`packages/api`, `apps/web`, …) along with the recipes it requires, and the
project owns it from then on ([../registry.md](../registry.md)). A recipe's
README arrives beside this index when the recipe is added; until then the links
below resolve in the registry.

Built from the October 2026 platform spike ([../spike-2026-10.md](../spike-2026-10.md)):

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

What each was run against, and what was not, is in its README and in
[../spike-2026-10.md](../spike-2026-10.md) (§ _Verdicts_ for the first group,
§ _Addendum_ for the second). How the registry checks them (`pnpm
recipes:check`) is in [../registry.md](../registry.md).
