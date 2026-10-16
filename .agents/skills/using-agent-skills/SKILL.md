---
name: using-agent-skills
description: Discovers and invokes agent skills. Use when starting a session, or when you need to decide which skill or workflow applies to the piece of work at hand. This is the meta-skill that governs how all other skills are discovered and invoked.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/using-agent-skills/SKILL.md
---

# Using Agent Skills

Follow [the upstream skill](../../3rdparty/agent-skills/skills/using-agent-skills/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win: they
are what this project's hooks and gates enforce.

## Amendments

### The lifecycle here

Upstream's phases and commands, with what this project puts behind each:

| phase  | entry                                                       | what this project adds                                                                                                                                                                |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEFINE | `/kickoff` once per project; `/spec` for every change after | requirements in `docs/requirements/`, written only under the requirements lock. Where the project has personas, **personas and journeys are the units of value** every feature serves |
| PLAN   | `/plan`                                                     | one file per item in `docs/plan/items/`: platform (`X-`) items first, then features by journey. Status comes from git, never from the file                                            |
| BUILD  | `/build`; `/build auto` builds every ready item             | one item per worktree, claimed first (`pnpm claim`)                                                                                                                                   |
| VERIFY | `/test`                                                     | a real database, never a hand-written fake; recorded journeys as evidence (the `journeys` skill)                                                                                      |
| REVIEW | `/review`; every commit is also reviewed by a hook          | the project's own criteria beside upstream's five axes                                                                                                                                |
| SHIP   | `pnpm land` per item; `/ship` for a release                 | `pnpm ci:local` is the CI; promotion is a fast-forward                                                                                                                                |

Two entry points are this project's own, not upstream's:

- **`/kickoff`**: the project is _defined_: people, product, personas and
  journeys, stack, architecture. Restartable; a re-run asks only what is open.
- **`pnpm bootstrap`**: the checkout is _configured_ to work in. It runs at
  the start of every session (a hook) and prints one line per check.

### The spec is the only human gate

A person approves the spec (`spec-driven-development`). Everything after it
runs as a pipeline: `/build auto` plans, claims, builds, reviews and lands every
ready item without asking, and stops only where `/build` says it must. The git
gates (`commit-msg`, `pnpm land`, `ci:local`) check that each step left its
evidence; a step skipped is a refusal, not a judgement call.

### Skills are invoked by the pipeline

Within a phase, apply the skills in upstream's lifecycle sequence yourself. Do
not wait for a person to name them.

### Names and paths

- Upstream commands name skills `agent-skills:<name>`; here each is plain
  `<name>`.
- Upstream's `references/` live in `.agents/3rdparty/agent-skills/references/`;
  its relative links resolve from the upstream file.
- Skills marked _(module)_ in their wrappers exist only once the module is
  added (`pnpm sdlc list`).
