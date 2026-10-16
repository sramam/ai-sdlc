@ai-sdlc/setup: Project setup and environment: `sdlc:init` (Phase 0), `sdlc:update` (pull upstream-owned paths), `bootstrap` (per-checkout checks, env symlinks), `accounts:check`, and `load-env`.

- `sdlc:init` creates `dev` through the GitHub API; the pre-push hook refuses pushing it.
- Env files are symlinked into worktrees, never copied, and never read by agents.
- `sdlc:update` never removes a project's line or value in a merge, never stages, and never overwrites a module in `modules.replaced`. A new owned path goes in `starter-manifest.json`, which a test checks against the repository.
