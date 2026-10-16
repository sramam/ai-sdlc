---
name: test-driven-development
description: Drives development with tests using the red-green-refactor loop. Use when implementing any logic, fixing any bug, or changing any behavior. Use when you need to prove that code works, when a bug report arrives, or when you're about to modify existing functionality. Use when asked to add tests to a function, fix a bug in it or change its behavior, even when the code is pasted inline and the request does not mention tests.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/test-driven-development/SKILL.md
---

# Test-Driven Development

Follow [the upstream skill](../../3rdparty/agent-skills/skills/test-driven-development/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- **The database is always real.** Upstream's ladder (real > fake > stub >
  mock) stands, with one rung removed: anything touching rows runs against the
  real test database (PGlite, through the `localdb` module), never a
  hand-written fake (`docs/kit/testing.md` says why); the commit-time code
  review blocks one. This
  supersedes the "fake DB" rung and the `jest.mock('./database')` example in
  `references/testing-patterns.md`. A spy that asserts what was written is
  fine. Mock only what upstream allows: slow or non-deterministic third
  parties.
- **A change to source carries a test.** `pnpm land` refuses a branch that
  changes source files and no test file, unless a commit says why with a
  `No-Test: <reason>` trailer. That is the evidence that the red step
  happened.
- **Journeys are the large tests.** Upstream's "large" size, for a feature that
  completes a journey, is a recorded journey (the `journeys` skill), not an
  ad-hoc browser script.
- **Coverage** _(module `coverage`)_: before committing a change to source,
  refresh the report as [coverage.md](coverage.md) says, once the module is
  added. Floors live in `sdlc.config.json` and are never quoted in prose.
