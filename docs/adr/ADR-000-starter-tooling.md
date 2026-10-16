# ADR-000: Starter tooling

Status: accepted (shipped by the ai-sdlc starter)

## Context

`plan:check --stage build` refuses a dependency that no ADR or architecture
entry accounts for. The starter itself brings development tooling before any
product decision exists.

## Decision

These root `devDependencies` are accounted for by this ADR: `typescript`,
`@types/node`, `eslint`, `@eslint/js`, `typescript-eslint`, `globals`,
`prettier`, `husky`, `lint-staged`, `vitest`. They exist to run the SDLC
tooling, linting, formatting and tests.

The `tooling/localdb` package depends on `@electric-sql/pglite`: Postgres
compiled to WebAssembly, served over the wire protocol by localdb's own socket
server, so each checkout gets its own database with no install and no shared
server (docs/kit/multi-agent.md, docs/kit/testing.md). Its tests use `pg` (and
`@types/pg`) as a real client to prove concurrent connections.

The `tooling/journeys` package depends on `pngjs` and `pixelmatch` (and the
dev-only `@types/pngjs`): decoding journey screenshots and diffing two of them
pixel by pixel, which is how a mask is learned and a step is compared. It
peer-depends on `@playwright/test` (also a pinned dev dependency, so its own
tests drive a real browser): the recorder, the fixtures and the Playwright
config are written against it. `pdfjs-dist` is an **optional** peer, resolved
from the project, for journeys that capture a PDF: rendered in the browser page
by page so a document is gated like a screenshot, and never installed by a
project that captures none.

Dependencies: @eslint/js, @types/node, eslint, globals, husky, lint-staged, prettier, typescript, typescript-eslint, vitest, pixelmatch, pngjs, @types/pngjs, @playwright/test, pdfjs-dist, @electric-sql/pglite, @vitest/coverage-v8, pg, @types/pg

## Consequences

Any other dependency needs its own ADR or an entry in `docs/architecture.md`.
Upgrades of these are routine and need no new ADR.
