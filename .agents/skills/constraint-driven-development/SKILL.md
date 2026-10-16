---
name: constraint-driven-development
description: Establishes a project's quality bar as a written contract and stops agents quietly lowering it. Interviews the user on which dimensions matter, supplies sane default thresholds when they have no number in mind, records everything in CONSTRAINTS.md, and watches the diff for a weakened bar — new @ts-ignore or eslint-disable suppressions, skipped or deleted tests, assertions stripped out, unimplemented stubs, thresholds edited down. Use when no quality bar is written down, when the user says "set up constraints" or "define our standards", when the user wants dimensions they care about — accessibility, web performance, coverage — set up as enforced constraints, when an agent keeps silencing checks or skipping tests to get to green, when you need a coverage or performance threshold and don't know what number to pick, or when an agent writes more code than anyone will read.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/constraint-driven-development/SKILL.md
---

# Constraint-Driven Development

Follow [the upstream skill](../../3rdparty/agent-skills/skills/constraint-driven-development/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- **The bar already has a home**: the steps of `pnpm ci:local`
  (`sdlc.config.json` → `ci.steps`) and the coverage floors there. Add a
  dimension as a step or a floor in that file, never as a second list. If
  `CONSTRAINTS.md` is written, each row names the dimension, its reason and the
  `ci:local` step that checks it, and points at `sdlc.config.json` for
  numbers rather than repeating them.
- **Upstream's `check:fast` / `check:task` / `check:full`** are, here,
  `pnpm lint && pnpm typecheck`, `pnpm test`, and `pnpm ci:local`.
- **Do not add a line to `AGENTS.md`** (it stays short; the router already
  sends agents here). Guard mode, which watches the diff for a lowered bar,
  applies as upstream says.
