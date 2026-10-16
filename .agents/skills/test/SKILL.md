---
name: test
description: Run TDD workflow — write failing tests, implement, verify. For bugs, use the Prove-It pattern.
metadata:
  upstream: .agents/3rdparty/agent-skills/.claude/commands/test.md
---

# /test

Follow [the upstream command](../../3rdparty/agent-skills/.claude/commands/test.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- Anything touching rows runs against the real database, never a fake
  (`test-driven-development`).
- For a journey, the evidence is a recording (`/journeys test`), not a
  DevTools session.
