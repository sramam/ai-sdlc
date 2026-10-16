# The SDLC, end to end

```
 /kickoff (how) ─▶ /idea (what: conversation → BRD + PRD) ─▶ docs/requirements/
                               │
                            /plan ─▶ docs/plan/items/*  (one file per item; status from git)
                               │
   any request ─▶ /add-requirement ─▶ item ─▶ /plan next (claim: push the item's branch)
                                            │
                     worktree from origin/dev ─▶ build · test ─▶ commit (Progress:, Closes: <item>)
                                                                         │
   /plan sync, progress reports ◀── plan:status ◀── dev ◀── /land: ci:local, local-ci status, merge commit
                                                    │
                                         promotion: dev ─ff─▶ staging ─ff─▶ main
```

## 0. Before any code: orient, vet, plan

| step                                                              | skill                                      | produces                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| orient the author: first pass, then the second pass after `/idea` | `/kickoff`                                 | the project brief, the decisions, `docs/architecture.md`, ADRs                                                                        |
| define the product                                                | `/idea`                                    | from a conversation or existing docs: `brd.md`, `prd.md`, discovered personas and access model, features and journeys with stable IDs |
| plan                                                              | `/plan`                                    | `docs/plan/`: milestones, items, the critical path                                                                                    |
| work                                                              | `/plan next` at the start of every session | the next ready item, claimed                                                                                                          |

## 1. Where work comes from

**The plan is in the repository.** There are no GitHub Issues and no Projects.
[plan-and-requirements.md](plan-and-requirements.md) has the layout, the IDs and
the pattern check.

- **`docs/requirements/` is locked.** Only `/kickoff`, `/idea` and
  `/add-requirement` may write it, enforced by a hook and a commit trailer.
- **Every request after discovery goes through `/add-requirement` first.** It
  triages: a trivial request gets no questions, work an existing requirement
  covers becomes a plan item, and a new feature gets the full checklist.
  Anything implying a new technology runs the decision dialog
  ([technology-decisions.md](technology-decisions.md)) and the user decides. It
  answers what it can from the repository, asks only what it cannot, and ends
  in a plan item.
- **Every change names its work**: a `Progress:` trailer for its item, or
  `No-Item: <reason>` for the genuinely item-less (a revert, a dependency bump,
  a report). A merge that names nothing appears in no report, so a productive
  week looked empty in door_nexa. `X-` items hold platform work.
- **Every item traces to a requirement, and every requirement to a persona and a
  journey.** `pnpm plan:check` fails on anything orphaned, unknown or
  duplicated. An unknown ID is refused, not created, because a typo would
  otherwise grow a phantom feature.
- **Questions only a person can answer** are `Q-` files listing what they
  `blocks:`. The author reviews them on the reporting cadence, and
  `plan:status` lists them by how much work each holds up.
- **Before starting an item, check it is still true.** Has the code it names
  changed since the item was written (`git log` on those paths)? Is it already
  claimed (`git branch -r`)? For a defect, does it still reproduce?

## 2. Branches and promotion

```
<item-id>-<slug> (lowercase) --PR--> dev --ff--> staging --ff--> main
```

- **The branch name starts with the item ID**, and pushing it is the claim.
- **Promotion is fast-forward only, never a PR into `main`.** A PR merge writes a
  commit `dev` never receives. `main` then stops being an ancestor of `dev`, and
  every later fast-forward is rejected. That happened twice.
- **If branch protection is ever bought, make it asymmetric:** require a PR on
  `dev` only. On `staging` and `main`, restrict who may push and require linear
  history.
- Run migrations **before** the promoting push, on a direct, unpooled
  connection. Rollback moves code back while the schema stays forward. So:
  - deprecate a column, then drop it a release or more later
  - add a `NOT NULL` column as nullable first

## 3. Building

See [AGENTS.template.md](AGENTS.template.md) § Building for the rules, and
[tech-stack.md](tech-stack.md) for the shape. The core of it: **one port, many
bindings.** Every capability is implemented once, in a framework-free package.
Server functions, HTTP routes, MCP tools and agent tools are thin transports over
it. **Every project exposes its API three ways from the start**: a typed SDK, an
HTTP API with OpenAPI, and an MCP server, all rendered from the manifest so they
cannot drift. A capability missing from any of them needs an exclusion in the
manifest with a reason that is a property of the mechanism, and a pattern check
fails the build otherwise ([`recipes/api-bindings`](recipes/api-bindings/)).

## 4. Committing

- `pre-commit` → `lint-staged`: lint, format, regenerate generated artifacts,
  re-stage.
- The commit body ends with trailers:
  ```
  Progress: F03-012 stop reminders on cancel — job + machine done; email copy remains
  Closes: F03-012
  Assumes: Q-007 → B          (only when building on an open question)
  ```
  `Closes:` goes **only** on the commit that finishes the item. That trailer is
  what makes the item _done_ once it reaches `origin/dev`.
- The trailers are `Co-Authored-By:` (model-free), `Worktree:` and `Session:`
  (automatic in a worktree).
- Agent reviewers run on `git commit` and block only on a concrete defect.

## 5. The pull request

- Into `dev`, always, from the item's branch. Use `/land`, which runs `pnpm land`:
  - make sure `origin/dev` is an ancestor (merge it in if not)
  - push
  - run `pnpm ci:local`, which also runs `plan:check` and posts a `local-ci`
    status on the pushed SHA
  - open the PR
  - re-check the status on the head SHA
  - merge with a merge commit
  - give the new `dev` tip its own `local-ci` status (a fingerprint hit, so
    instant)
- **The branch must advance a plan item**: at least one `Progress:` trailer, or
  a `No-Item:` trailer. The grammar is in [hooks.md](hooks.md).
- **CI is local by default.** GitHub Actions minutes get expensive fast, and a
  laptop runs the same suite for free. The gate is only as honest as its
  process, so:
  - it tests a branch that has `origin/dev` as an ancestor, and refuses one that
    is behind (it never merges)
  - it refuses a dirty tree
  - the verdict is pinned to a SHA, and a moved head invalidates it
  - _could not run_ holds the merge
- **Enabling Actions** is the author's call. When it happens, use one workflow
  that runs `pnpm ci:local` unchanged, so there is only one definition of CI.

## 6. After the merge

- Nothing needs updating by hand. The item reads _done_ in `plan:status` as soon
  as its `Closes:` commit is on `origin/dev`.
- Treat the **`local-ci` status on `dev`'s tip** as the "dev is green" signal for
  anything that advances work toward QA. _Unknown_ holds it back. A promise to QA
  must not rest on an absence.

## 7. QA tests journeys, not items

An item is not something a person can _get done_. A journey (`J<nn>`) is. Three
skills, each run by a different hand:

- **describe** a journey: who, what sequence, every refusal
- **validate** it: record evidence per path
- **release** it to QA: a person signs off. A green run says the paths that exist
  pass. It cannot say the right paths were written.

A journey is ready to walk when every item serving its requirements is done.
`plan:status --journeys` answers that.

## 8. Cadence

| when                            | what                                                                                                 | written by                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- |
| twice a week                    | `docs/progress/YYYY-MM-DD.md`: Shipped, Decided, **Cost a day**, Open, plus a `plan:status` snapshot | `/progress-report`, from `git log` |
| same cadence                    | `/plan sync`: discovered work placed, answered questions applied, critical path re-derived           | a skill                            |
| weekly, if stakeholders want it | `plan:status --html`: one page to send                                                               | generated                          |
| on each commit                  | coverage figures                                                                                     | the gate's own run                 |
| when an ADR lands               | the decisions index                                                                                  | a skill                            |

A progress report is **never** rewritten: it records what was known then. The
plan's forecast is **always** recomputed: a stale forecast is a lie.

With Actions off there are no scheduled jobs, so the cadence is
**session-driven**. `/pickup` says when a report or a plan sync is due.
