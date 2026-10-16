---
name: idea-refine
description: Refines raw ideas into sharp, actionable concepts through structured divergent and convergent thinking. Use when an idea is still vague, when you need to stress-test assumptions before committing to a plan, or when you want to expand options before converging on one. Triggers on "ideate", "refine this idea", or "stress-test my plan".
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/idea-refine/SKILL.md
---

# Idea Refine

Follow [the upstream skill](../../3rdparty/agent-skills/skills/idea-refine/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- Inside `/kickoff` or `spec-driven-development`, the one-pager feeds the
  conversation; what is decided is recorded in `docs/requirements/` by that
  skill, and the _Not Doing_ list becomes the BRD's out-of-scope section. Save
  to `docs/ideas/` only when neither is running and the person asks for it.
