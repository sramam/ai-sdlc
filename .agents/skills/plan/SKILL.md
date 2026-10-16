---
name: plan
description: Break work into small verifiable tasks with acceptance criteria and dependency ordering
metadata:
  upstream: .agents/3rdparty/agent-skills/.claude/commands/plan.md
---

# /plan

Follow [the upstream command](../../3rdparty/agent-skills/.claude/commands/plan.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- The plan is `docs/plan/` as `planning-and-task-breakdown` says; no `tasks/`.
- `/plan` plans; `/plan sync` re-plans (that skill, § _Re-planning_); other
  arguments are ignored.
- No plan checkpoint: `build` § _`/build auto`: every ready item_.
