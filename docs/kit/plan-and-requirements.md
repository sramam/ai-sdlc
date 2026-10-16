# Plan and requirements live in the repository

There is no GitHub Issues and no GitHub Project. The requirements, the plan,
open questions and progress all live in `docs/`, are versioned with the code,
and are reported against from `git`. This works for one reason: **git is the
only channel that merges** across agents, so making it the system of record
removes a second source of truth and the sync between the two.

These documents get long. What keeps them usable by people and by agents is that
**every persona, feature, requirement, journey and work item has a stable ID and
its own place**. An agent loads the one feature it is working on, not the whole
PRD.

## Layout

```
docs/requirements/             LOCKED: only /kickoff and /spec write here
  sources/                    imported documents, verbatim, never edited
  project-brief.md            kickoff's decisions (how it gets built)
  technology.md               every technology trigger, and the ADR deciding it
  review.md                   findings, assumptions, and the readiness verdict
  brd.md                      the business requirements: why, for whom, success, scope, rules, risks
  prd.md                      the product overview, feature index, non-functional requirements
  personas.md                 the persona registry (discovered)
  access-model.md             tenancy, membership, roles × capabilities, row scope (discovered)
  domain-model.md             high-level objects, relationships, lifecycles, ER diagram (discovered; see data-model.md)
  ux.md                       the design brief (see the kit's ux.md)
  glossary.md                 one word per concept
  features/
    F01-onboarding.md         one file per feature: its requirements, personas, journeys
    F02-billing.md
  journeys.md                 J-numbered journeys, one persona per J<nn>.<n>, task → requirement
docs/plan/
  README.md                   milestones, order, critical path, assumptions (narrative)
  items/
    F01-001-invite-member.md  one file per work item
    X-004-ci-local.md         platform work (X = cross-cutting)
  questions/
    Q-007-payment-vendor.md   one file per question waiting on a person
docs/progress/YYYY-MM-DD.md   dated reports, never rewritten
```

A requirements skill imports a document by creating a **new** file under
`sources/` with Write, then `pnpm sources:add <path>` records its hash in
`sources/MANIFEST`, which the `sources` CI step checks.

## IDs

| kind        | form                       | example        | rules                                                                                                                                                         |
| ----------- | -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| persona     | `@slug`                    | `@organizer`   | defined once in `personas.md`, after discovery (below)                                                                                                        |
| feature     | `F<nn>`                    | `F03`          | the file name carries a slug too: `F03-reminders.md`                                                                                                          |
| requirement | `F<nn>-R<nn>`              | `F03-R07`      | numbered within its feature                                                                                                                                   |
| journey     | `J<nn>`, `J<nn>.<n>`       | `J12`, `J12.2` | `J<nn>` may span personas; `J<nn>.<n>` names exactly one; its tasks cite requirements (`.agents/skills/spec-driven-development/requirements.md` § _Journeys_) |
| work item   | `F<nn>-<nnn>` or `X-<nnn>` | `F03-012`      | numbered within its feature; `X` for platform work                                                                                                            |
| question    | `Q-<nnn>`                  | `Q-007`        |                                                                                                                                                               |

- **IDs are stable and never reused.** A dropped requirement keeps its ID and is
  marked `withdrawn`, with a date and reason. A renumbered ID silently re-points
  every reference to it.
- **Two agents can allocate the same next number.** Allocate after `git fetch`,
  checking `origin/dev` and remote branches. The pattern check below catches a
  duplicate, and the later branch renames before landing.

## Personas are discovered, not assumed

No persona carries over from one project to the next; what carries over is the
**method** (`.agents/skills/kickoff/discovery.md`). `/kickoff` runs it in stage
2, BRD theme 2 (`.agents/skills/kickoff/product.md`), and
`/kickoff revisit product` repeats it when a request names an actor that is not
in the registry.

**What `personas.md` declares for each persona:**

- ID and a one-line description
- goals (their top jobs-to-be-done)
- what they may and may not do
- how they arrive: sign-up, invitation, or no account
- context: how often they use it, on what device, and how skilled they are
- the journeys they own

**Uncertain is allowed, if it is said.** Mark a persona `provisional`, and link the
`Q-` file that will settle it. `plan:check` lists provisional personas, so none
stays provisional silently.

## Tenancy and access are discovered, not assumed

Tenancy decides the data model, the scoping layer, the tests and the auth flow,
so it is **discovered from the product definition** in `/kickoff` stage 2, BRD
theme 5 (`.agents/skills/kickoff/discovery.md`), and recorded before any schema
is written.

**What `docs/requirements/access-model.md` declares**, plus an ADR for the
model chosen:

- **tenancy**: a `Tenancy: <model>` line (never `open` once decided), with the
  reason
- **the concrete "must never see" pairs**
- **membership**: how a user relates to a tenant. The role belongs to the
  **relationship**, not the person; one person can be an admin in one tenant and
  a member in another
- **two axes, always both**: _may this role do this action_ (a persona ×
  capability table) and _which rows may it touch_ (the scope rule per entity)
- **row-scope rules are an allow-list per entity.** An entity not listed is
  refused, not open; the most private default holds wherever the definition is
  silent (principles.md §10)
- **shells**: one per persona group (customer front, and the backoffice for
  operators, support and product admins), each with the roles that land in it.
  Whether the backoffice is a separate shell or a separate app is settled in
  `/kickoff` stage 3
- **switching**: a person may hold several relationships (different roles in
  different tenants, a customer and staff). Exactly **one is active at a time**,
  chosen explicitly through a switcher, and the active relationship decides
  both the shell and the row scope. It is never inferred, and never a merge of
  several
- **cross-tenant staff**: who they are, how access is granted, and how it is
  audited

**Unsettled tenancy is blocking.** It is cheap to decide on day one and expensive
to change after the schema exists. If it is open, the data model waits; work
that does not touch it carries on. `plan:check` reports an `open` access model
as blocking.

## What each document holds

**`personas.md`**: for each persona, its ID, who they are, their goals, what
they may and may not do (the RBAC row), and the journeys they own. Write it
**first**. Everything else references it.

**`features/F<nn>-<slug>.md`**:

_(Illustration only. The example below is an event-scheduling app; your IDs come from your own project.)_

```markdown
# F03 Reminders

Personas: @organizer, @attendee Journeys: J12, J13
Phase: MVP Owner: <person>

## Purpose one paragraph, in the user's terms

## Requirements

### F03-R01 Remind attendees 24 hours before a session

Actor: system:scheduler · Trigger: … · Preconditions: …
Main flow: …
Refusals: … (every one)
Acceptance: Given … When … Then … (testable)
Data: … Lifecycle: states/events, and who sends each
Non-functional: …

### F03-R02 …

## Out of scope what this feature deliberately does not do

## Open questions Q-007, Q-011

## Decisions ADR links
```

**`journeys.md`**: for each journey, its persona-level journeys (or its one
persona) and their tasks, and each task cites the requirement IDs it exercises
(`.agents/skills/spec-driven-development/requirements.md` § Journeys). This is how a reader sees that a
feature is complete _for someone_.

**`plan/items/<id>-<slug>.md`**:

```markdown
---
id: F03-012
title: Stop reminders when a session is cancelled
requirements: [F03-R04]
personas: [@attendee]
journeys: [J12]
milestone: M2
depends: [F03-010, X-004]
estimate: 3            # or "unknown". Never a guess
---

## Acceptance copied from the requirement, made concrete

## Notes approach, risks, assumptions (Assumes: …)
```

**There is no `status:` field.** Status is derived from git, because a stored
status drifts (principles.md §14):

| status          | derived from                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| **done**        | a commit on `origin/dev` with the trailer `Closes: F03-012`                                                          |
| **in progress** | a **claim**: a remote branch named exactly the item ID (`f03-012`), or a recent `Progress:` on dev without `Closes:` |
| **blocked**     | a `depends:` item not done, or an open question listing this item                                                    |
| **ready**       | none of the above                                                                                                    |
| **dropped**     | `dropped: <date> <reason>` in the frontmatter, the one stored state, because it is a decision                        |

**A claim is atomic.** `pnpm claim <ID>` creates, through the GitHub API, a
branch named **exactly** the lowercased item ID on top of `origin/dev`, whose
first commit records who and when:

```
Claim: F03-012

Claimed-By: <session id or user email>
Claimed-At: <ISO time>
```

A second claim of the same item is the same ref, so GitHub refuses it ("already
held by …"); there is no race to resolve. The work happens on that branch, in a
worktree created from `origin/<id>`; the worktree's directory name may carry a
slug the user chooses, but the branch is the ID.

- **IDs are matched case-insensitively** everywhere. Branches are lowercase;
  files and trailers use the uppercase form.
- **A branch is deleted when its item closes** (`pnpm land` deletes it on the PR
  carrying `Closes:`). An item is also _in progress_ while `origin/dev` carries a
  recent `Progress: <ID>` and no `Closes: <ID>`, so a partial PR never makes it
  look free.
- **A claim goes stale** when its `Claimed-At` is older than `claimStaleDays`
  (in `sdlc.config.json`) and no commit, including a `Progress:` on dev, is newer. `plan:status` flags it, and `/plan sync` asks its owner, or the
  author, before it is released.
- Requirements work uses `req-<slug>` branches (not claims). The bootstrap items
  are claimed like any other: `x-000`, `x-001`.

**`plan/questions/Q-<nnn>-<slug>.md`**: for anything only a person can answer.

```markdown
---
id: Q-007
asked: 2026-10-15
blocks: [F04-001, F04-002]
owner: <person>
answered: # date, once answered
---

## Question ## Options (with what each changes) ## Recommendation

## Answer the person's words, verbatim, and who gave them
```

A question with no `answered` date is open. Answering it may produce an ADR.

## The pattern check — what keeps this honest

`pnpm plan:check` prints its table on success. It runs in **stages**, because
what must hold grows as the project does. Each stage includes the ones before
it, and the highest stage the repository has reached is used (`--stage`
overrides it):

| stage             | reached when                                                                                                    | says                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **pre-discovery** | no discovery output exists yet (base)                                                                           | `NOT STARTED`, never a plain pass            |
| **requirements**  | any discovery output exists                                                                                     | every mandatory output present and non-empty |
| **plan**          | `docs/plan/README.md` holds a written plan                                                                      |                                              |
| **build**         | a workspace package with a `package.json` exists outside `tooling/`, or the plan README declares `Stage: build` |                                              |

**requirements** also requires the full set: `brd.md`, `prd.md`, `glossary.md`,
`ux.md`, `domain-model.md`, `technology.md`, `review.md`, `personas.md` with at
least one persona, `features/` with at least one requirement, `journeys.md` with
at least one journey, and `access-model.md` declaring its tenancy (`Tenancy:
<model>`, not `open`). `review.md` carries exactly one machine-readable verdict
line:

```
Verdict: ready-to-plan | ready-with-assumptions | ready-pending-decisions | not-ready
```

The requirements stage passes at `ready-pending-decisions` or better; the plan
stage requires `ready-to-plan` or `ready-with-assumptions`.

**requirements** (the end of kickoff's stage 2):

- a duplicate ID, or a reference to an ID that does not exist; a withdrawn ID
  reappearing
- a requirement served by no journey, or a journey step citing no requirement
- a feature naming no persona, or a persona with no journey
- an actor in a requirement that is neither a registered persona nor
  `system:<name>`
- a `provisional` persona, reported every run alongside the `Q-` that settles it
- an entity named in a requirement that `domain-model.md` does not define, or a
  lifecycle event with no sender
- a technology trigger in `technology.md` that is neither decided nor listed as
  pending with its requirement IDs
- an access model whose tenancy is still `open` (blocking)

**plan** (the end of `/plan`):

- a work item citing no requirement (unless it is `X-` work)
- a feature item whose feature carries no `Approved: YYYY-MM-DD by <name>` line
- an MVP requirement with no item covering it, unless withdrawn or out of scope
- a `depends:` cycle
- a technology trigger still pending without `blocks:`
- a component in `docs/architecture.md` citing no requirement or ADR

**build** (once code exists):

- a `Progress:` or `Closes:` trailer naming an item that does not exist
- a dependency (in any field of any `package.json`) that no ADR or
  `docs/architecture.md` lists on a structured line: `Dependencies: pkg-a,
@scope/pkg-b`. A name mentioned only in prose does not count. Base's own
  tooling dependencies are listed by `ADR-000-starter-tooling`

This is the same shape as every other pattern check here (principles.md §6).

## Reporting against the plan

- **`pnpm plan:status`** derives every item's status from git and prints it, by
  milestone, feature and persona, with open questions and what each one blocks.
  It is generated on demand and **not committed**, so there is no shared file
  for agents to conflict on.
- **Progress reports** (`docs/progress/YYYY-MM-DD.md`) include a `plan:status`
  snapshot. That snapshot is history, which is why it may be committed.
- **For stakeholders without repo access**, `plan:status --html` renders the
  same thing as one page to publish or send. It is a view, not a source.

## What giving up GitHub Issues costs, said rather than discovered

| lost                                   | replacement or accepted gap                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a UI for non-technical people          | `plan:status --html`; questions answered in chat are written into `Q-` files by the agent                                                                                     |
| PR ↔ issue auto-linking and auto-close | the `Closes: <item>` trailer, checked by `ci:local` and `pnpm land`                                                                                                           |
| outside bug reports                    | **accepted gap.** Reports arrive by whatever channel the project brief names, and each one goes through `/spec`. Turning GitHub Issues on, even for intake only, needs an ADR |
| notifications                          | none. The author reviews `plan:status` on the reporting cadence                                                                                                               |
