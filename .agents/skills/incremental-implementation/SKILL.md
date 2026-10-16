---
name: incremental-implementation
description: Delivers changes incrementally in thin, verifiable slices. Use when implementing any feature or change that touches more than one file, or when picking up the next task from a plan. Use when rolling a change out behind a feature flag, when you're about to write a large amount of code at once, or when a task feels too big to land in one step.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/incremental-implementation/SKILL.md
---

# Incremental Implementation

Follow [the upstream skill](../../3rdparty/agent-skills/skills/incremental-implementation/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- **A slice is a commit on the item's branch**, with the trailers in
  `git-workflow-and-versioning` § _Commits carry trailers_; the item was
  claimed and its worktree created first (§ _Starting an item_), one item per
  worktree.
- **Finishing the item is landing it**: `pnpm land`, which runs `ci:local`.
  Nothing ticks a task off; `Closes:` on `origin/dev` is what makes it done.
