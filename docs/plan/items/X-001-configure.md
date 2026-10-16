---
id: X-001
title: Configure and prove the SDLC tooling
requirements: []
personas: []
journeys: []
milestone: M0
depends: [] # part 2 waits for kickoff's first pass to land (docs/kit/BOOTSTRAP.md Phase 2)
estimate: unknown
---

## Acceptance

- `sdlc.config.json` filled in: branches, accounts (from kickoff's decisions),
  cadence, `claimStaleDays`.
- Root `AGENTS.md` written from `docs/kit/AGENTS.template.md`.
- `pnpm accounts:check` prints a line per account, none _could not ask_.
- Every guard in docs/kit/BOOTSTRAP.md Phase 2 tripped, each refusal pasted into
  this item's PR.

## Notes

Shipped in base (`ai-sdlc init`). Independent of the product, so it runs in parallel with
X-000 (docs/kit/BOOTSTRAP.md Phase 2).
