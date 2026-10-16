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

- Upstream names skills `agent-skills:<name>` (its plugin namespace); here
  each is plain `<name>`, and its wrapper in `.agents/skills/` carries this
  project's amendments.
- Anything touching rows runs against the real database, never a fake
  (`test-driven-development`).
- For a journey, the evidence is a recording (`/journeys test`), not a
  DevTools session.
