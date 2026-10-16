# Recipes

Reference implementations of the packages most projects need. **Not wired into
the build**: the foundation items instantiate the ones `/kickoff` chose into
`apps/` and `packages/`, and the project owns them from then on
(docs/kit/starter-repo.md).

Planned: `api`, `db`, `ui`, `telemetry`, `authz-oso`, `authz-spicedb`,
`llm-openrouter`, `env-schema`, `app-tanstack-workers`, `dev-session`. They
depend on the platform spike for TanStack Start on Workers and are not built
yet.
