@ai-sdlc/setup: Project setup and environment: `sdlc:init` (Phase 0), `bootstrap` (per-checkout checks, env symlinks), `accounts:check`, and `load-env`.

- `sdlc:init` creates `dev` through the GitHub API; the pre-push hook refuses pushing it.
- Env files are symlinked into worktrees, never copied, and never read by agents.
