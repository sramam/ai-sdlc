# @ai-sdlc/setup

Project setup and environment: `sdlc:init` (Phase 0), `bootstrap` (per-checkout checks, env symlinks), `accounts:check`, and `load-env`. Copying the kit into a project, and keeping it in step, is the `ai-sdlc` CLI's (`pnpm sdlc`, docs/kit/registry.md).

The project's own: it arrives with `ai-sdlc init`; `pnpm sdlc diff base` shows what changed upstream, and `pnpm sdlc update base` takes it without overwriting a local edit (docs/kit/registry.md).
