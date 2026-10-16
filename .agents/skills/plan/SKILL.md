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

- Upstream names skills `agent-skills:<name>` (its plugin namespace); here
  each is plain `<name>`, and its wrapper in `.agents/skills/` carries this
  project's amendments.
- The plan is `docs/plan/` as `planning-and-task-breakdown` says; no `tasks/`.
- `/plan sync` re-plans (that skill, § _Re-planning_).
- Planning stops for no approval of its own: the spec was the gate.
