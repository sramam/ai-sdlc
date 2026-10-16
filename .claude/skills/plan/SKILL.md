---
name: plan
description: Builds and works the plan in docs/plan/ — one file per work item, status derived from git, questions as files. `/plan` creates it (foundation X- items first, then features by journey); `/plan next` claims the next ready item and creates its worktree and branch (after the user confirms or renames it); `/plan sync` reconciles. No GitHub Issues or Projects.
---

# Plan

The structure, IDs and `plan:check` stages are in
`docs/kit/plan-and-requirements.md`. Read it first. There are three modes:
`/plan` (create), `/plan next` (choose and claim) and `/plan sync` (reconcile).

## `/plan` — create (bootstrap Phase 3, in the `X-000` worktree)

1. **Inputs**: the project brief, everything under `docs/requirements/`, and
   `docs/architecture.md`. Refuse if the verdict in `review.md` is not
   **ready to plan** or **ready with assumptions**, or if the project brief's
   Blocking list is not empty, unless the author overrides that in writing.
2. **Foundation first, as `X-` items**, in the order in `docs/kit/BOOTSTRAP.md`
   Phase 3:
   - the platform spike
   - apps and packages from recipes
   - infrastructure
   - environments and promotion
   - security baseline
   - telemetry
   - UI foundation
   - test harness

   Each item gets its acceptance criteria, and the guards it must trip.

3. **Then features, ordered by journey, not by layer.** A half-built journey is
   worth nothing, so each milestone completes one or more journeys end to end.
   Seeds and authorization-matrix cells for an entity arrive with the item that
   creates that entity, not before.
4. **Write one file per item** in `docs/plan/items/`. Each records its
   requirements, personas, journeys, milestone, `depends:` and estimate
   (`unknown`, rather than a guess). Acceptance criteria are copied from the
   requirement and made concrete.
5. **Write `docs/plan/README.md`**:
   - the milestones, each with the journeys it completes and its items
   - a mermaid dependency graph
   - the critical path
   - the assumptions from the review
   - what was deliberately deferred

   It holds no statuses or counts; `pnpm plan:status` gives those.

6. Run `pnpm plan:check --stage plan`, and fix every finding. Put `Closes: X-000`
   on the commit that lands the plan.
7. **Show the author the plan** before code starts. Record their changes as
   edits, plus a line in the README's change log. Land the plan.

## `/plan next` — choose and claim

1. `git fetch`, then `pnpm plan:status --ready`. **Ready** means:
   - not done
   - not claimed (no live remote branch carries its ID)
   - every `depends:` is done
   - no open question blocks it
2. Prefer, in order:
   - critical-path items
   - items that unblock the most others
   - items closest to finishing a journey
3. **This session's previous worktree**: close it if it has landed. If it has
   not, finish and land it first, or say why it is parked. There is one live
   worktree per session.
4. **Unclear item? Stop here**, before any worktree, and print `/add-requirement
<item>` as the next step. Skills do not call each other.
5. **Claim it, then name the worktree.** `pnpm claim <ID>` creates the branch
   named exactly the lowercased ID on GitHub, atomically. Exit 3 means someone
   else holds it: say who, and pick again. Then propose the worktree name
   (`f03-012-<slug>`; ask once, "keep it" as the default) and create it from the
   claim branch:
   ```bash
   git fetch origin f03-012
   git worktree add .claude/worktrees/f03-012-<slug> f03-012
   ```
   Then, in the new worktree: `pnpm install && pnpm bootstrap`, and
   `EnterWorktree({ path })`.
6. If the item is a defect, reproduce it first. Never guess.
7. Report: the item, why this one, and the first command.

**If nothing is ready, do not stop.** Report which open questions block the most
work. Then, in order:

- work on a blocked item where every answer needs the same thing
- proceed on a reversible assumption, recorded with `Assumes:`
- quality work: coverage, pattern checks, docs
- print `/idea check` for the next milestone's features, as a suggestion

## `/plan sync` — reconcile, on the cadence in `sdlc.config.json`

- **Discovered work** becomes new items. Each is placed in a milestone, or
  marked `dropped:` with a reason. New _requirements_ go through
  `/add-requirement`, not here.
- **Answered questions**: write the answer into the `Q-` file, and unblock what
  it blocked. Write an ADR if the answer shapes the system.
- **Stale claims**: a claimed branch with no commit for `claimStaleDays` (from
  `sdlc.config.json`) is reported. Ask its session, or the author, before
  releasing it.
- Re-derive the critical path. Write any slipped milestone into the README's
  change log; never edit old dates away.
- Run `pnpm plan:check` (it selects its stage).

## Never

- store a status in an item file (only `dropped:`, which is a decision)
- renumber or reuse an ID
- rewrite the README's change log
