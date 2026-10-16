---
name: context-engineering
description: Optimizes agent context setup. Use when starting a new session, when agent output quality degrades, when switching between tasks, or when you need to configure rules files and context for a project.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/context-engineering/SKILL.md
---

# Context Engineering

Follow [the upstream skill](../../3rdparty/agent-skills/skills/context-engineering/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- **Five tenets hold all agent-facing context**: clarity, actionability,
  fidelity, efficiency and security (`docs/kit/principles.md` § 0). Apply
  [context-quality.md](context-quality.md) to anything you write for an agent
  to act on, here or in any skill. Upstream's context hierarchy says _where_
  context goes; the checklist says _what makes it good_.
- **The rules file stays short.** `AGENTS.md` (with `CLAUDE.md` importing it)
  points into `docs/kit/` and `docs/guardrails.md` rather than restating them,
  so it cannot drift from what the hooks enforce. Write a new convention where
  it is enforced or where its area's docs live, and link it.
- **Session boundaries are files, because a worktree dies with its session.**
  Upstream's restartable boundary is, here:
  - at the end of a session, after the last commit: [handoff.md](handoff.md),
    written into the main checkout
  - at the start: `pnpm bootstrap` lists the newest handoffs; read and verify
    them against git ([pickup.md](pickup.md)) before any work
