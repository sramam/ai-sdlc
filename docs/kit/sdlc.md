# The SDLC, end to end

The phases and commands are Addy Osmani's
[agent-skills](https://github.com/addyosmani/agent-skills) (copied verbatim into
`.agents/3rdparty/agent-skills/`); what this project puts behind each is in
the wrapper skills in `.agents/skills/`, and the map is
`.agents/skills/using-agent-skills/SKILL.md`.

```
 DEFINE   /kickoff (once: people, product, personas + journeys, stack, architecture)
          /spec    (each change after: docs/requirements/, under the lock)
            │
            ▼  a person approves the spec (Approved:)   ← the only human gate
 PLAN     /plan ─▶ docs/plan/items/*  (platform X- items first, then features by journey; status from git)
            │
 BUILD    /build auto: for every ready item ─▶ claim ─▶ worktree from origin/dev
            │        ─▶ slices: red · green · commit (Progress:, Closes: <item>)
 VERIFY   /test, /journeys test (recorded evidence per persona journey)
 REVIEW   hooks on every commit; /review; security-and-hardening + claude-security
            │
 SHIP     pnpm land: ci:local, local-ci status, merge commit ─▶ dev
          /ship: release ─▶ dev ─ff─▶ staging ─▶ journeys to QA ─▶ ─ff─▶ main
            │
 CONTINUE handoff ─▶ (next session) pnpm bootstrap lists it ─▶ pickup; /plan sync; progress reports
```

## 0. Before any code: define, approve, plan

| step                              | skill                                       | produces                                                                                                               |
| --------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| configure the checkout            | `pnpm bootstrap` (runs at session start)    | one line per check; repairs what it can                                                                                |
| define the project                | `/kickoff`                                  | the project brief, BRD, PRD, personas, journeys, access and domain models, the decisions, `docs/architecture.md`, ADRs |
| approve the first features' specs | a person                                    | an `Approved:` line on each feature                                                                                    |
| plan, then build every ready item | `/build auto` (plans if nothing is planned) | `docs/plan/`, then landed items                                                                                        |
| a new ask, later                  | `/spec`                                     | a triaged change: no spec, a plan item, or edited requirements awaiting approval                                       |

## 1. Where work comes from

**The plan is in the repository.** There are no GitHub Issues and no Projects.
[plan-and-requirements.md](plan-and-requirements.md) has the layout, the IDs and
the pattern check.

- **`docs/requirements/` is locked.** Only `/kickoff` and `/spec` may write it,
  enforced by a hook and a commit trailer.
- **Every request after kickoff goes through `/spec` first.** It triages: a
  trivial request gets no questions, work an existing requirement covers becomes
  a plan item, and a new feature gets the full checklist. Anything implying a
  new technology runs the decision dialog
  ([technology-decisions.md](technology-decisions.md)) and the user decides. It
  answers what it can from the repository, asks only what it cannot, and stops
  for a person to approve the spec.
- **A person approves each spec, once; nothing after that waits for one.** The
  approval is an `Approved:` line on the feature, and `plan:check` refuses an
  item built from a feature without it. From there `/build auto` plans, claims,
  builds, reviews and lands, and stops only on red, ambiguity, or something
  irreversible.
- **Every change names its work**: a `Progress:` trailer for its item, or
  `No-Item: <reason>` for the genuinely item-less (a revert, a dependency bump,
  a report). A merge that names nothing appears in no report. `X-` items hold
  platform work.
- **Every item traces to a requirement, and every requirement to a persona and a
  journey.** `pnpm plan:check` fails on anything orphaned, unknown or
  duplicated. An unknown ID is refused, not created, because a typo would
  otherwise grow a phantom feature.
- Questions only a person can answer are `Q-` files listing what they
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
  every later fast-forward is rejected.
- If branch protection is ever bought, make it asymmetric: require a PR on
  `dev` only. On `staging` and `main`, restrict who may push and require linear
  history.
- Run migrations before the promoting push, on a direct, unpooled
  connection. Rollback moves code back while the schema stays forward. So:
  - deprecate a column, then drop it a release or more later
  - add a `NOT NULL` column as nullable first

## 3. Building

See [AGENTS.template.md](AGENTS.template.md) § Building for the rules, and
[tech-stack.md](tech-stack.md) for the shape. The core of it: one port, many
bindings: every capability is implemented once, in a framework-free package,
and every transport (server functions, HTTP, SDK, MCP, agent tools) is rendered
from its manifest ([`recipes/api-bindings`](recipes/api-bindings/)).

## 4. Committing

- `pre-commit` runs `lint-staged`: lint, format, regenerate generated artifacts,
  re-stage.
- The commit body ends with trailers:
  ```
  Progress: F03-012 stop reminders on cancel — job + machine done; email copy remains
  Closes: F03-012
  Assumes: Q-007 → B          (only when building on an open question)
  Co-Authored-By: …           (exactly what settings say; no model name)
  Worktree: … / Session: …    (added by prepare-commit-msg in a worktree)
  ```
  `Closes:` goes only on the commit that finishes the item. That trailer is
  what makes the item _done_ once it reaches `origin/dev`.
- A branch that changes source changes a test too, or a commit says why not
  (`No-Test: <reason>`); the trailer check in `ci:local` refuses it otherwise.
- Agent reviewers run on `git commit` (the commit review and the code review's
  project criteria) and block only on a concrete defect.

## 5. The pull request

- Into `dev`, always, from the item's branch, through `pnpm land`
  (`.agents/skills/git-workflow-and-versioning/landing.md`):
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
- Enabling Actions is the author's call. When it happens, use one workflow
  that runs `pnpm ci:local` unchanged, so there is only one definition of CI.

## 6. After the merge

- Nothing needs updating by hand. The item reads _done_ in `plan:status` as soon
  as its `Closes:` commit is on `origin/dev`.
- Treat the `local-ci` status on `dev`'s tip as the "dev is green" signal for
  anything that advances work toward QA. _Unknown_ holds it back.

## 7. QA tests journeys, not items

A journey (`J<nn>`) is something a person can _get done_. The
`journeys` module's skill has three commands, each run by a different hand:

- `/journeys add <id>` registers a described journey: who, what sequence,
  every refusal
- `/journeys test <id>` records evidence per path
- `/journeys ready-for-qa <id>` releases it to QA, once a person signs off.
  What a green run proves is in [testing.md](testing.md) § _Organising it_.

A journey is ready to walk when every item serving its requirements is done.
`plan:status --journeys` answers that.

## 8. Cadence

| when                               | what                                                                                             | written by                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| on `cadence` in `sdlc.config.json` | `docs/progress/YYYY-MM-DD.md`: Shipped, Decided, Cost a day, Open, plus a `plan:status` snapshot | `/progress-report`, from `git log` |
| same cadence                       | `/plan sync`: discovered work placed, answered questions applied, critical path re-derived       | a skill                            |
| weekly, if stakeholders want it    | `plan:status --html`: one page to send                                                           | generated                          |
| on each commit                     | coverage figures                                                                                 | the gate's own run                 |
| when an ADR lands                  | the decisions index                                                                              | a skill                            |

A progress report is never rewritten: it records what was known then. The
plan's forecast is always recomputed: a stale forecast misleads.

With Actions off there are no scheduled jobs, so the cadence is
session-driven. `/pickup` says when a report or a plan sync is due.
