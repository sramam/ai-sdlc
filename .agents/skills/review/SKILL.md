---
name: review
description: Conduct a five-axis code review — correctness, readability, architecture, security, performance
metadata:
  upstream: .agents/3rdparty/agent-skills/.claude/commands/review.md
---

# /review

Follow [the upstream command](../../3rdparty/agent-skills/.claude/commands/review.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- For a change touching auth, authorization, money, uploads, webhooks, model
  routing or secrets, also run `security-and-hardening`'s review and scan.
