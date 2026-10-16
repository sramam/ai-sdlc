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

## Consequences

Any other dependency needs its own ADR or an entry in `docs/architecture.md`.
Upgrades of these are routine and need no new ADR.
