---
id: X-000
title: Discovery — define the product and decide how it is built
requirements: []
personas: []
journeys: []
milestone: M0
depends: []
estimate: unknown
---

## Acceptance

- `/kickoff` stage 1 (orientation) done: people, SDLC defaults, budget, first accounts,
  working agreements.
- `/kickoff` stage 2 (the product) done: `docs/requirements/` holds the BRD, PRD, personas, access model,
  domain model, design brief, features, journeys, glossary, `technology.md` and
  `review.md`.
- `/kickoff` stage 3 (decisions) done: the stack, every technology trigger (decided by
  the user through the dialog), apps, packages and scope, backoffice split, AI
  architecture; `docs/architecture.md` written, every component citing a
  requirement or ADR.
- `review.md` verdict is `ready-to-plan` or `ready-with-assumptions`; the
  project brief's Blocking list is empty.
- `pnpm plan:check --stage requirements` passes.
- `/plan` has written the plan, the author has seen it, and
  `pnpm plan:check --stage plan` passes.

## Notes

Shipped in base (`ai-sdlc init`): every project has it (docs/kit/BOOTSTRAP.md Phase 1 and 3).
