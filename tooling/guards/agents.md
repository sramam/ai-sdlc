@ai-sdlc/guards: The hooks. Claude Code PreToolUse/PostToolUse: `worktree-required`, `worktree-base`, `worktree-single`, `worktree-trace`, `requirements-lock`. Git: `provenance` (prepare-commit-msg), `trailers` (commit-msg, and `--range` for ci:local). Plus `pnpm worktrees`.

- Every guard answers yes, no or _could not ask_, and says which. Could-not-ask allows, and says so.
- Hooks run as `node tooling/guards/src/<name>.mts`: no `node_modules`, so relative imports only.
- Prove a guard by tripping it with real hook JSON, not only by its unit tests.
