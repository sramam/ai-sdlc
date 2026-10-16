# @ai-sdlc/guards

The hooks. Claude Code PreToolUse/PostToolUse: `worktree-required`, `worktree-base`, `worktree-single`, `worktree-trace`, `requirements-lock`. Git: `provenance` (prepare-commit-msg), `trailers` (commit-msg, and `--range` for ci:local). Plus `pnpm worktrees`.

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`. A project that needs different behaviour replaces the module and lists it in `sdlc.config.ts` `modules.replaced` (docs/kit/starter-repo.md).
