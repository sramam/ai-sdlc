---
name: code-review-and-quality
description: Conducts multi-axis code review. Use before merging any change. Use when reviewing code written by yourself, another agent, or a human. Use when you need to assess code quality across multiple dimensions before it enters the main branch. Use when asked to review a diff or a pull request, even when the diff is pasted inline.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/code-review-and-quality/SKILL.md
---

# Code Review and Quality

Follow [the upstream skill](../../3rdparty/agent-skills/skills/code-review-and-quality/SKILL.md)
in full, with the amendments below.

## Amendments

- **Add the [project criteria](project-criteria.md)** to upstream's five axes.
  They are the checks only this stack can ask.
- **Every commit is reviewed by a hook** (`.claude/settings.json`), against both,
  before `git commit` runs; it blocks only on a concrete defect. An interactive
  review (`/review`) is the full report.
- **Who approves a merge** is decided in `/kickoff` (topic _People_), not
  assumed. Where it is nobody, a green `local-ci` status from `pnpm land` and
  the hook reviews are the gate; upstream's "a human approved before merge"
  applies only where kickoff named one.
