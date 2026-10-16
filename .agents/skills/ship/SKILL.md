---
name: ship
description: Run the pre-launch checklist via parallel fan-out to specialist personas, then synthesize a go/no-go decision
metadata:
  upstream: .agents/3rdparty/agent-skills/.claude/commands/ship.md
---

# /ship

Follow [the upstream command](../../3rdparty/agent-skills/.claude/commands/ship.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- **Scope**: every commit on `origin/dev` since the last release tag
  (`git describe --tags --abbrev=0`), or the first commit when there is none.
- **The three personas** are this project's (`.claude/agents/`), which wrap
  upstream's with the project criteria and the threat model.
- **Two more inputs to the decision**, run while the personas work: Claude
  Security's _scan codebase_ job, and the threat-model review _(module
  `security`)_ (`security-and-hardening`). A confirmed finding from either is a
  blocker. One that could not run is a NO-GO until a person accepts it.
- **`local-ci` on the commit** must be green; a red or missing status is NO-GO.
- **After GO**: `shipping-and-launch` § _`/ship` decides; promotion deploys_.
