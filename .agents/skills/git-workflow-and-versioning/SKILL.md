---
name: git-workflow-and-versioning
description: Structures git workflow practices. Use when making any code change. Use when committing, branching, resolving conflicts, splitting uncommitted work in a messy working tree into clean atomic commits, opening or reviewing a pull request (PR), pushing to a remote, or when you need to organize work across multiple parallel streams. Use when cutting a release, choosing a semantic version bump, tagging, or writing a changelog.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/git-workflow-and-versioning/SKILL.md
---

# Git Workflow and Versioning

Follow [the upstream skill](../../3rdparty/agent-skills/skills/git-workflow-and-versioning/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win: each
one is enforced by a hook or a gate, and the refusal costs a round trip.

## Amendments

### The trunk is `dev`

Upstream's trunk-based model holds with `dev` in place of `main`. `staging` and
`main` move only by fast-forward promotion (`pnpm promote:staging`,
`pnpm promote:prod`, the `promote` module). Nothing pushes to `dev`, `staging`
or `main` directly; `.claude/settings.json` denies it.

### Starting an item: claim, then a worktree

Several agents share one plan, so a branch is a claim:

1. `pnpm plan:status --ready`; pick by critical path, then what unblocks most,
   then what finishes a journey. An unclear item is a spec question
   (`spec-driven-development`), not a guess.
2. `pnpm claim <ID>` creates the branch named the lowercased ID on GitHub,
   atomically. Exit 3: someone else holds it; pick again.
3. Create the worktree inside the checkout, from the claim branch:
   `git fetch origin <id> && git worktree add .claude/worktrees/<id>-<slug> <id>`,
   then `pnpm install && pnpm bootstrap` there and `EnterWorktree({ path })`.
   Never `../project-feature-a`: the guards allow one live worktree per
   session, under `.claude/worktrees/`, forked from `origin/dev`.

Work that is not an item (a requirements change, a fix to the tooling) uses a
plain branch from `origin/dev` in the same place.

### Commits carry trailers

Upstream's atomic commits and messages, plus a trailer block the `commit-msg`
hook requires (grammar: `docs/kit/hooks.md`):

- `Progress: <ID> <covered; remains>` on every commit for an item, and
  `Closes: <ID>` on the one that finishes it; or `No-Item: <reason>`
- `Requirements: kickoff|spec` on any commit touching `docs/requirements/`
- `No-Test: <reason>` on a branch that changes source and no test (rare; see
  `test-driven-development`)

Two agent hooks review every `git commit` before it runs: the commit review
([commit-review.md](commit-review.md)) and the code review
(`code-review-and-quality`). Each blocks only on a concrete defect.

Upstream's save points stand, but never `git reset --hard` over work you have
not committed, and never a bare `git stash` (the stash is shared by every
worktree).

### Merging: `pnpm land`, and nothing else

A finished branch reaches `dev` only through `pnpm land`
([landing.md](landing.md)). `gh pr merge`, force pushes and `--no-verify` are
denied. It runs `pnpm ci:local`, the project's CI, which costs nothing per run.

### Versions

`pnpm release` (the `promote` module, [release.md](release.md) once added) tags
a green commit on `origin/dev`; its notes come from the trailers. A tag names
code; it does not move a branch or release anything to QA.
