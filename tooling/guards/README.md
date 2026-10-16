# @ai-sdlc/guards

The hooks. Claude Code PreToolUse/PostToolUse: `worktree-required`, `worktree-base`, `worktree-single`, `worktree-trace`, `requirements-lock`. Git: `provenance` (prepare-commit-msg), `trailers` (commit-msg, and `--range` for ci:local). Plus `pnpm worktrees`.

The project's own: it arrives with `ai-sdlc init`, and is changed here when the project needs it. `pnpm sdlc diff base` shows what changed upstream; `pnpm sdlc update base` takes it without overwriting a local edit (docs/kit/registry.md).
