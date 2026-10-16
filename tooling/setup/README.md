# @ai-sdlc/setup

Project setup and environment: `sdlc:init` (Phase 0), `sdlc:update` (pull upstream-owned paths), `bootstrap` (per-checkout checks, env symlinks), `accounts:check`, and `load-env`.

**`sdlc:update [--ref starter/main] [--dry-run]`** reads `starter-manifest.json` from the starter and applies each owned path: `replace` with `git restore --source=<ref> --worktree`, `merge-json` and `merge-lines` in-process (`src/merge.mts`: idempotent, and never removing a project's addition). Modules in `modules.replaced` are skipped. It refuses a dirty tree (a `--dry-run` looks anyway) and a config that does not load (it could not tell which modules are the project's), could-not-ask without a `starter` remote, and refuses a project whose `configVersion` is below the manifest's `minConfigVersion`. It writes the starter's version to `.sdlc-version` and prints every `docs/kit/MIGRATIONS.md` section newer than the project's. It never stages or commits. `--dry-run` prints the plan per path (replace, merge, skip, unchanged, n/a) and writes nothing. A starter without a manifest falls back to restoring the derived upstream paths.

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`. A project that needs different behaviour replaces the module and lists it in `sdlc.config.json` `modules.replaced` (docs/kit/starter-repo.md).
