---
name: api-and-interface-design
description: Guides stable API and interface design. Use when designing APIs, module boundaries, or any public interface. Use when creating REST or GraphQL endpoints, defining type contracts between modules, or establishing boundaries between frontend and backend.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/api-and-interface-design/SKILL.md
---

# API and Interface Design

Follow [the upstream skill](../../3rdparty/agent-skills/skills/api-and-interface-design/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- **One port, three bindings.** Every capability is defined once (its Zod
  input and output, its authorization) and exposed as an SDK, an HTTP API and
  an MCP server from that one definition (`docs/kit/tech-stack.md` § _The
  architecture shape_; the `api` and `api-bindings` recipes). Design the
  capability; the bindings follow.
