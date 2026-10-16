# @ai-sdlc/setup

Project setup and environment: `sdlc:init` (Phase 0), `sdlc:update` (pull upstream-owned paths), `bootstrap` (per-checkout checks, env symlinks), `accounts:check`, and `load-env`.

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`. A project that needs different behaviour replaces the module and lists it in `sdlc.config.ts` `modules.replaced` (docs/kit/starter-repo.md).
