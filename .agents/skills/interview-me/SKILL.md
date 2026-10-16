---
name: interview-me
description: Extracts what the user actually wants instead of what they think they should want. Achieves this through one-question-at-a-time interview until ~95% confidence about the underlying intent. Use when an ask is underspecified ("build me X" without "for whom" or "why now"), when the user explicitly invokes ("interview me", "grill me", "are we sure?", "stress-test my thinking"), or when you catch yourself silently filling in ambiguous requirements before any plan, spec, or code exists.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/interview-me/SKILL.md
---

# Interview Me

Follow [the upstream skill](../../3rdparty/agent-skills/skills/interview-me/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- Inside `/kickoff` or `spec-driven-development`, the answers are recorded
  where those skills record them (`docs/requirements/`, the project brief),
  not in `docs/intent/`. Save to `docs/intent/` only when neither is running
  and the person asks for it.
