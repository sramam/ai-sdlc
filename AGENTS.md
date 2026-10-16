# ai-sdlc: the registry

This repository is the registry `ai-sdlc init` and `ai-sdlc add` copy from.
It is not a project and not a template. `README.md` says what it is;
`docs/kit/registry.md` says how it works.

- `registry.json` lists every item. Every file here belongs to exactly one item
  or is excluded there with a reason; `scripts/registry/pattern-check.test.ts`
  enforces it, with each item's imports and npm dependencies.
- The CLI is `scripts/registry/cli.mjs`: plain `.mjs` with JSDoc types and no
  dependencies, because it runs from `node_modules` under `pnpm dlx`, where
  Node will not strip types.
- `template/` holds the project-shaped root files (`AGENTS.md`, `CLAUDE.md`,
  `package.json`, `sdlc.config.json`) that differ from this repository's own.
- `pnpm test` covers everything here. `pnpm registry:check` (installs) proves
  `init`, `add`, `diff` and `update` end to end; `pnpm recipes:check` (installs)
  builds every recipe through `add`.
- Work in a worktree forked from `origin/dev`, as in any project here.
- Skills live in `.agents/skills/` (Claude Code sees them through symlinks in
  `.claude/skills/`). Third-party skills follow `docs/kit/registry.md`
  § _Third-party skills_.
- Everything here is context an agent acts on, in this repository and in every
  project it creates. Hold it to the five tenets (`docs/kit/principles.md`
  § 0) with `.agents/skills/context-engineering/context-quality.md`.
