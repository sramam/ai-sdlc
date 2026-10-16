# Project memory — what keeps a project consistent

Many sessions and many agents work on one project, and each starts with an
empty context. **The project's memory is the repository**, because git is the
only channel every agent and every machine shares. Anything that matters and
lives elsewhere is, for practical purposes, forgotten.

## The layers

| layer                            | holds                                                                | loaded                   | written by                                 |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------ | ------------------------------------------ |
| `AGENTS.md` (via `CLAUDE.md`)    | how to work here: short, imperative rules                            | every session            | Phase 2, then a line per process decision  |
| `docs/guardrails.md`             | the non-negotiables                                                  | every session (imported) | the starter, `/kickoff`, ADRs              |
| `docs/architecture.md`, personas | the shape of the system and who it is for                            | every session (imported) | `/kickoff`, `/idea`, `/add-requirement`    |
| `docs/requirements/`             | what is built, and why; the project brief; technology decisions      | when relevant            | the three requirement skills only          |
| `docs/adr/`                      | each architecture decision with its argument, and when to revisit it | when relevant            | `/kickoff`, `/add-requirement`, the dialog |
| `docs/plan/`                     | what is next, what is open (`Q-` files), what is blocked             | `/plan next`, `/pickup`  | `/plan`, agents                            |
| `git log` trailers               | what moved and which line of work moved it (`Progress:`, `Session:`) | reports                  | every commit                               |
| `docs/progress/`                 | what shipped, what was decided, **what cost a day**                  | when relevant            | `/progress-report`                         |
| package `agents.md`              | the traps specific to one package                                    | when working in it       | whoever meets the trap                     |

**Not memory**, deliberately:

- **Claude's auto-memory** (`~/.claude/projects/…`) is personal and per machine.
  It may hold a user's preferences. It is never the place for a project rule,
  because no other agent or machine sees it. If a memory turns out to be a
  project fact, promote it into the repo and delete the memory.
- **Handoffs** (`docs/handoffs/`) are machine-local reports for the next
  session, and are verified against git before anyone acts on them.
- **Chat and messages between agents** die with the session. Anything durable
  becomes a commit, a plan item or a `Q-` file.

## How a lesson becomes memory

Something costs time, and the question is where its lesson goes so that nobody
pays for it twice:

1. **Fix it**, and **add a guard** if one is possible: a test, a pattern check, a hook,
   a lint rule. A guard is memory that cannot be skipped.
2. **Write the rule where it will be read**, as one line:
   - a non-negotiable → `docs/guardrails.md`
   - how to work → `AGENTS.md`
   - a trap in one package → that package's `agents.md`
   - a design choice → an ADR
3. **Put the story in the commit and the PR**, not in the rule. The progress
   report's _Cost a day_ section collects them.
4. **Never let a rule file grow into a history book.** If a rule needs a
   paragraph of justification to be followed, it is not enforced yet; go back
   to step 1.

`/progress-report` ends with a **promote** step. For each _Cost a day_ entry, is
its lesson written where it will be read (step 2), and is it guarded (step 1)?

## Across projects: lessons flow back to the starter

A lesson that is not about this project's domain belongs to every project.

- **Upstream-owned paths** (`docs/kit/`, `tooling/<module>/`,
  the starter's skills) are never edited in a project. A general lesson is a
  **pull request to `ai-sdlc`**: a kit doc, a guard, a skill step.
- `/progress-report`'s promote step asks a second question: **would every
  project want this?** If so, it drafts the upstream change, and a person opens
  it against the starter.
- Projects pull improvements with `pnpm sdlc:update`, which shows the diff for
  review. So a lesson learned once reaches every project, and the starter stays
  the single source of how projects are run.
