# @ai-sdlc/plan

The plan in the repo: parsing `docs/requirements/` and `docs/plan/` (the markdown conventions are in the header of `plan-lib.mts`), `plan:check` (the staged census), `plan:status` (derived from git), `item-check`.

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`. A project that needs different behaviour replaces the module and lists it in `sdlc.config.ts` `modules.replaced` (docs/kit/starter-repo.md).
