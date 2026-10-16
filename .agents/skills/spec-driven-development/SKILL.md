---
name: spec-driven-development
description: Creates specs before coding. Use when starting a new project, feature, or significant change and no specification exists yet. Use when drafting a PRD or requirements document with objectives and scope, or when requirements are unclear, ambiguous, or only exist as a vague idea. Use when a single requirement spans several independently testable capabilities and needs decomposing into a capability map of modules before specifying.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/spec-driven-development/SKILL.md
---

# Spec-Driven Development

Follow [the upstream skill](../../3rdparty/agent-skills/skills/spec-driven-development/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

### Before the project is defined, run `/kickoff` instead

No `docs/requirements/project-brief.md` yet means the project has not been
defined. A spec for one change needs the product it changes.

### The spec system is `docs/requirements/`

This is upstream's _external spec tool_ case: keep this format, never write
`SPEC.md` or `SPEC-<id>.md`. The layout and the ID rules are in
`docs/kit/plan-and-requirements.md`; [requirements.md](requirements.md) has the
per-feature checklist and the checks a spec must pass.

| upstream's spec area                     | here                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| objective, success criteria              | the feature file `features/F<nn>-<slug>.md`: requirements `F<nn>-R<nn>`, each with Given / When / Then |
| capability map (Phase 0)                 | the feature index in `prd.md`, with each feature's dependencies                                        |
| who it is for                            | `personas.md` and `journeys.md` (where the project has personas)                                       |
| commands, structure, code style, testing | already in `AGENTS.md` and `docs/kit/`; do not restate them                                            |
| boundaries (always / ask first / never)  | `docs/guardrails.md`                                                                                   |
| open questions                           | `docs/plan/questions/Q-<nnn>.md`, each with `blocks:`                                                  |

### Personas and journeys are the units of value

Where the project has personas, every requirement is served by a journey task,
and journeys have three levels: a journey that may span personas, a journey per
persona under it, and the tasks within each ([requirements.md](requirements.md)
§ _Journeys_). A feature that completes no journey is not yet worth building.

### Triage first

| the ask                                    | outcome                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| trivial (a typo, a rename, a version bump) | no spec: a commit with `No-Item: <reason>`                                            |
| already covered by a requirement           | no spec change: a plan item citing it (`/plan`). Cite what you found; never re-ask it |
| changes a requirement                      | edit it in place, the old text struck through with the date and the reason            |
| a new feature                              | a new `F<nn>`, the full checklist, journey tasks                                      |
| a new persona or product area              | `/kickoff revisit product`                                                            |

For a bug, reproduce it before deciding which row it is.

### Writing under the requirements lock

A hook refuses edits to `docs/requirements/` unless this session holds the lock:

1. One live worktree per session: land or close any other first. If another
   unmerged branch is changing `docs/requirements/` (`git log
origin/dev..origin/<branch> -- docs/requirements` over the remote
   branches), work on something else until it lands.
2. Create a worktree on a branch `req-<slug>` from `origin/dev`, and claim the
   lock: `echo "$CLAUDE_CODE_SESSION_ID spec" > .claude/requirements-session`.
3. Write the spec. Commit with a `Requirements: spec` trailer.
4. Release the lock (`rm .claude/requirements-session`) and land the branch
   (`pnpm land`) before any code that depends on it. A requirements branch
   contains nothing else; `pnpm land` refuses one that does.

### New technology: the user decides

If the spec needs anything the decided stack and the ADRs do not cover, run the
dialog in `docs/kit/technology-decisions.md` (options, including "not now";
current sources; a recommendation with a confidence). The user decides; the
decision is an ADR and a row in `docs/requirements/technology.md`. Keep
specifying whatever does not depend on it.

### Approval is recorded

Upstream's gate stands: present the spec and stop the turn. When a person
(never another agent) answers with an unambiguous yes, add
`Approved: YYYY-MM-DD by <name>` under the feature's title and commit it, still
under the lock. `pnpm plan:check` refuses a plan item for a feature with no
`Approved:` line, so nothing downstream starts on an unapproved spec. This is
the only human gate: once it is recorded, `/build auto` takes it from there.
