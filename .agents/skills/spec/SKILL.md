---
name: spec
description: Start spec-driven development — write a structured specification before writing code
metadata:
  upstream: .agents/3rdparty/agent-skills/.claude/commands/spec.md
---

# /spec

Follow [the upstream command](../../3rdparty/agent-skills/.claude/commands/spec.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- Upstream names skills `agent-skills:<name>` (its plugin namespace); here
  each is plain `<name>`, and its wrapper in `.agents/skills/` carries this
  project's amendments.
- No project brief yet (`docs/requirements/project-brief.md`)? Run `/kickoff`.
- The spec is written where `spec-driven-development` says (`docs/requirements/`,
  under the requirements lock), never `SPEC.md`. Its approval is recorded with
  an `Approved:` line; that is the one human gate.
