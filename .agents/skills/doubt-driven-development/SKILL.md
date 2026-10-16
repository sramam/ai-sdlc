---
name: doubt-driven-development
description: Subjects every non-trivial decision to a fresh-context adversarial review before it stands. Use when you want every assumption cross-examined before proceeding, when stress-testing a plan for hidden failure modes, when correctness matters more than speed, when working in unfamiliar code, when stakes are high (production auth, security-sensitive logic, a high-stakes migration, irreversible operations), or any time a confident output would be cheaper to verify now than to debug later.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/doubt-driven-development/SKILL.md
---

# Doubt-Driven Development

Follow [the upstream skill](../../3rdparty/agent-skills/skills/doubt-driven-development/SKILL.md)
in full, with the amendment below. Where they differ, the amendment wins.

## Amendment

- Upstream says what to doubt; `agent-review` Level 3 says how the review is
  run: the self-audit (each claim measured, verified, inferred or assumed),
  cold reviewers with isolation that is tested rather than assumed, findings
  verified against the source before a fix, and fresh eyes after it. Use its
  reviewer templates and its register for the review upstream asks for.
