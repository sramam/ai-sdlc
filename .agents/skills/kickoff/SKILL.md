---
name: kickoff
description: Defines a new project with its author, so it can be built without asking — who decides and reviews, the product (BRD, PRD, personas, journeys, access and domain models, design brief), the stack and every technology it implies, the apps and packages, and the architecture. Interviews topic by topic until every decision the SDLC depends on is decided, deferred with an owner, or out of scope. Restartable and non-destructive — a re-run asks only what is still open, and never overwrites a recorded answer. Writes docs/requirements/, docs/architecture.md and the first ADRs. `/kickoff revisit <topic>` reopens one deliberately; `/kickoff status` reports.
---

# Kickoff

**Checklist (read this first; details follow):**

1. Claim the requirements lock; release it when done.
2. Stage 1, orientation: topics 2, 4, 5, 6, 8.
3. Stage 2, the product: topic 1, by [product.md](product.md), checked as
   `spec-driven-development`'s [requirements.md](../spec-driven-development/requirements.md) says.
4. Stage 3, decisions: topics 3, 7, 9–12, running the technology dialog for every
   recorded trigger; the user decides.
5. Write `docs/architecture.md`; every component cites a requirement or ADR.
6. Ask only what is open; never overwrite an answer (`revisit` keeps history).
7. Done when a re-run asks nothing. A person approves the first features'
   specs (`Approved:`), then `/build auto` plans and builds.

Purpose: nothing gets built on an unasked question. Every topic below ends
in one of three end states: decided, deferred (with an owner and a date), or
out of scope. "We'll see" is not a state.

After kickoff, a change to what the product does goes through `/spec`
(`spec-driven-development`). A new persona or product area comes back here:
`/kickoff revisit product`.

## Writing to `docs/requirements/`

The project brief lives at `docs/requirements/project-brief.md`, which is
locked. On start, claim the lock (`echo "$CLAUDE_CODE_SESSION_ID kickoff" >
.claude/requirements-session`). If `$CLAUDE_CODE_SESSION_ID` is empty, stop:
the lock cannot be claimed. Release it on finish, and mark commits
`Requirements: kickoff`. `docs/architecture.md` and the ADRs are outside the
lock, but every component in them cites a requirement or an ADR.

## Three stages, in order

The order matters because the decisions depend on the product, and the product
interview goes better once the people and the defaults are settled.

1. **Orientation**: the topics that do not depend on the product (2, 4, 5, 6,
   8). Mark the rest `waiting`, with the reason "needs the product".
2. **The product**: topic 1, the _what_, by [product.md](product.md). It
   records the decisions it implies (technology triggers, the
   authorization-engine recommendation, the backoffice candidates) in
   `docs/requirements/technology.md` without making them.
3. **Decisions**: settle topics 3, 7 and 9–12, deciding what stage 2 recorded
   through the dialog in `docs/kit/technology-decisions.md`. The user decides.

A run may stop between stages (or anywhere); the next one resumes at the first
open question. `state` may also be `waiting`, which re-runs skip until its
reason clears.

## Restartable by design

Run it once, or ten times: each run solves only for what is open, and
nothing already answered is lost or re-asked.

| invocation                 | does                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| `/kickoff`                 | first run: creates the brief. Later runs: resume, asking only open questions     |
| `/kickoff status`          | prints each topic's state and what is open, then asks nothing and writes nothing |
| `/kickoff revisit <topic>` | reopens one decided topic deliberately, keeping its history                      |

### The state lives in the brief, per topic

Each topic in `docs/requirements/project-brief.md` carries a machine-readable marker:

```markdown
## 3. Stack

<!-- kickoff: topic=stack state=decided updated=2026-10-15 -->

- Framework: TanStack Start — decided 2026-10-15 (ADR-003)
- Database host: **open** — Q-003
```

`state` is one of `open`, `partial`, `waiting`, `decided`, `deferred` or
`out-of-scope`.
State is tracked per question within the topic, not just per topic, so a
partly answered topic resumes at its first open line.

### What a re-run does, in order

1. **Read, never regenerate.** Load the existing brief and parse its markers. If
   the brief is missing, this is a first run. If it exists but cannot be parsed,
   stop and say so. Do not rebuild it from scratch: that would discard
   answers.
2. **Collect answers that arrived elsewhere.** For each `Q-` file the brief
   references, read it as it stands on `origin/dev` and on this branch:
   - **`answered:` is set, with an answer**: propose recording that answer in
     the brief, and confirm it with the author in one batch
   - **`answered:` is set, with no answer text**: treat it as still open, and
     say so
   - **not answered**: still open
   - **the file is missing or cannot be parsed**: _could not ask_. Report it and
     leave the question's state unchanged. Never treat it as answered.
3. **Notice drift, but do not act on it.** Flag any of these:
   - `docs/requirements/` changed since the brief's `Last reviewed` date in a way that
     touches a kickoff decision. A tenancy change, for example, reopens Stack
     (`git log --since`)
   - an ADR that supersedes a recorded decision
   - a deferred item past its date

   A flagged topic is offered for revisit. It is not reopened automatically.

4. **Ask only what is open**: `open` or `partial` questions, overdue deferrals,
   and any new topics added to this skill since the last run. Everything
   `decided` or `out-of-scope` is skipped silently, apart from one summary line.
5. **Write in place, one question at a time.** Change only the lines that were
   answered. Update the marker and `Last reviewed`. Never reorder, reformat or
   reword text you did not change. An interrupted run therefore loses at most
   the question in flight.
6. Append to the run log at the bottom of the brief: date, what was asked,
   what was decided, what is still open.

### Non-destructive rules

- **A recorded answer is never overwritten by a re-run.** Changing one takes
  `/kickoff revisit <topic>`. The old answer is then struck through with its
  date, the new one is added, and the reason for the change is written down:
  ```markdown
  - ~~Auth: magic link — decided 2026-10-15~~ → email OTP — decided 2026-11-02 (magic links blocked by client mail filter)
  ```
  If the decision had an ADR, write a new ADR that supersedes it. Never edit
  the old ADR.
- **Human edits to the brief win.** If the author edited the brief by hand, keep
  the edit, and re-parse the markers around it. If an edit removed a marker,
  restore the marker and keep the text.
- **Never delete a `Q-` file, or rewrite its question.** Write the answer into
  it when one arrives. Create new `Q-` files only for questions that are newly
  deferred, and first check that no open question already asks the same thing.
- **ADRs are created, never rewritten.** Before creating one, check whether an
  ADR for that decision already exists.
- `/kickoff status` writes nothing at all.

## How to interview

Use `interview-me`'s method: one question at a time, each with your best guess
and how confident you are, and probe what the author wants against what they
think they should want. Within that:

- **One topic at a time.** For each one, offer a recommended default and say
  what it costs. Use the AskUserQuestion tool where it fits, with the
  recommendation first. A topic whose answers are all defaults to confirm may
  go as one batch.
- **Confirm what is already decided rather than re-asking it.** On a first run,
  read the existing documents first: `docs/requirements/`, README, notes.
- **When the author does not know**, write a `Q-` file, mark the question
  _deferred_ with an owner and date, and move on. Do not stall.
- Push back on an answer that contradicts a recorded decision or the
  requirements. Name the contradiction, and offer `revisit` if the old decision
  is the one that should change.

## Topics

1. **Product definition** (stage 2): the _what_, by [product.md](product.md).
   The brief records its state: the verdict in `review.md`, whether the access
   model is settled, and the open `Q-` files.
2. **People**:
   - who decides product questions, and who approves specs (the only human
     gate, `using-agent-skills`)
   - who reviews code, if anyone beyond the hooks and `ci:local`
   - who does QA, and what QA tests
   - who holds credentials and accounts
3. **Stack**: present the preferred stack in `docs/kit/tech-stack.md`,
   one choice at a time; the user keeps or changes each (a change is an ADR): TanStack Start on Cloudflare Workers, OTel, OpenRouter, shadcn/ui.
   Decide the rest using its criteria:
   - database (Postgres through Hyperdrive, or D1) and ORM
   - auth provider
   - **authorization engine**: Oso or SpiceDB, starting from stage 2's
     recommendation in `technology.md`
   - OTel backend for production (Grafana Cloud's free tier unless there is a
     reason; local is always VictoriaLogs, `docs/kit/observability.md`
     § _Backends_), with its ingestion and retention limits written in the
     brief
   - email, SMS and payments
   - whether GPUs are needed, and for which data class (vast.ai rules in
     `docs/kit/security.md`)

   For each third-party service: decided, or undecided? An undecided vendor
   gets a port. Read `docs/requirements/access-model.md` and
   `docs/requirements/domain-model.md` first: tenancy constrains the database layout, auth and the scoping layer,
   and the domain objects' volumes and access paths constrain the database and
   host. UI defaults to shadcn/ui on Base UI (`docs/kit/ux.md`), so confirm
   rather than ask. D1 is outside the kit: the testing, branching and health
   patterns assume Postgres, so choosing D1 needs an ADR that replaces them.

4. **SDLC defaults** (confirm):
   - the plan in the repo (`docs/plan/`), with no GitHub Issues or Projects
   - local CI, with Actions off
   - merge commits
   - `dev` as the default branch
   - promotion by fast-forward
   - worktree per agent
   - environments: local (per checkout), dev, staging, production; previews
     optional (`docs/kit/environments.md`)
5. **Budget**: GitHub plan (branch protection?), Git LFS storage and bandwidth
   (journey screenshots), hosting tier, database branch limits, LLM spend per
   tenant per day and per run.
6. **Accounts and credentials**: each one with an owner. These are the
   commonest blocker, so start them on day one.
   1. Derive the list from the decisions: GitHub, Cloudflare and OpenRouter
      always (stage 1); then the database host, the OTel backend, Oso Cloud or
      AuthZed, the email, SMS and payment vendors, vast.ai, Lovable and Figma,
      as each is decided (stage 3).
   2. Prefer each vendor's CLI for login and provisioning
      (`docs/kit/tech-stack.md` § _CLIs first_). A person logs in once per
      machine.
   3. Record the CLIs in `sdlc.config.json`; `pnpm accounts:check` confirms
      each one.
   4. Give anything with no CLI a documented manual step with a check.
7. **Delivery risks**: technical unknowns, and the spike that retires each.
   Product risks live in the BRD.
8. **Working agreements**:
   - reporting cadence
   - how and when the author wants to be asked things
   - what agents may do without asking

   Every non-negotiable that comes out of this becomes one line under
   _This project's own_ in `docs/guardrails.md`, with what enforces it.

9. **Apps and packages**: decided here, never assumed. Base ships none.
   Derive the surfaces from the personas and journeys, for example: one web app
   with role-based areas, or a separate admin app, a public marketing site, a
   public API, a mobile app, a background-worker app, a design-system viewer.
   **For each app, decide whether it needs a database and whether it needs seeded
   mock data** (a marketing site may need neither; an operator console both).
   These become `localdb.databases` and `seeds` in `sdlc.config.json`.
   Each app and each initial package (`api`, `db`, `ui`, `telemetry`, `authz`,
   `llm`, one per decided vendor) cites the requirements or ADR that need
   it. Also decide the package scope (`@<scope>/…`). Start with the fewest. A second app needs a reason it cannot be a
   route in the first. Settle the backoffice split from the candidates stage 2 recorded:
   a separate app (its own origin, a smaller blast radius, MFA everywhere, staff
   only) suits sensitive or high-power operations, while a separate shell in the
   same app suits light administration. Whichever is chosen, the backoffice
   never shares a shell with the customer front.
   Name the items each one starts from (`pnpm sdlc list`): the recipe per
   package or app (`app-tanstack-workers`, `api`, `api-bindings`, `db-drizzle`
   or `db-prisma`, `authz-oso` or `authz-spicedb`, `llm-openrouter`, `ui`,
   `dev-session`, `journeys-adapter`), and the modules the SDLC defaults need
   (`security` and `coverage` always; `localdb` for a database, `seed` for mock
   data, `journeys` for journeys, `promote` for deployed environments). Record
   the list in the brief; the foundation items run `pnpm sdlc add` for it, so
   nothing is added before it is decided.
10. **Architecture**: write `docs/architecture.md` from everything decided:
    - the apps, packages and runtime
    - the data store and how it is reached
    - the authorization engine
    - the integrations, background work, telemetry and environments

    Include one diagram, and the main flows (sign-in, a capability call, a
    background job). Every component cites a requirement ID or an ADR. A
    component with no citation is either missing its requirement or should not
    exist.

11. **Technology triggers**: confirm that every trigger stage 2 found has a
    user-made decision. Then scan the non-functional side for triggers the
    product conversation would not raise: availability targets, multi-region,
    data residency, expected load, compliance attestations, offline use. Each one
    runs the dialog in `docs/kit/technology-decisions.md`, and the user decides.
    Record every decision in `docs/requirements/technology.md` with its ADR.
12. **AI architecture**: from the `## AI` section of `prd.md`, settle what
    `docs/kit/ai.md` § _Architecture_ describes:
    - the agent binding over the capability manifest. The SDK, HTTP API and
      MCP bindings are a default every project gets (`docs/kit/tech-stack.md`
      § _The architecture shape_), so ask instead:
      - which capabilities are excluded from which binding, each with a
        reason that is a property of the mechanism (a browser-only upload
        step), never "not needed yet"
      - **how external clients authenticate**: API keys for programmatic HTTP
        and SDK callers (who may create them, their scopes, expiry), and OAuth
        for MCP (which clients may register, what the consent screen offers)
    - propose-then-approve for consequential actions
    - the semantic layer for plain-language BI (the model never writes SQL)
    - the onboarding draft lifecycle
    - where AI runs are recorded
    - per-tenant cost caps

    Each item cites its requirement.

New topics may be appended to this list. Existing briefs pick them up as `open`
on their next run. Never renumber or rename a topic: the `topic=` key in the
marker is what matches a brief to this list.

## Output: `docs/requirements/project-brief.md`

```markdown
# <Project> — project brief

Last reviewed: YYYY-MM-DD

## 1. Product definition

<!-- kickoff: topic=product-definition state=… updated=… -->

→ docs/requirements/brd.md · prd.md · access-model.md (stage 2); verdict · open Q-s
…one section per topic, in the order above…

## Decided — one line each, linking an ADR where it shapes the system

## Deferred — question — owner — date — Q-<nnn>

## Blocking — anything that stops planning (bootstrap Phase 3). An unsettled access model always does

## Run log — append-only: date · asked · decided · still open
```

The Decided, Deferred and Blocking summaries are derived from the
markers on every run, not edited by hand. That way they cannot disagree with
the sections they summarise.

## Done when

- Every topic is decided, deferred with an owner, or out of scope.
- Blocking is empty, or the author has said to proceed anyway. Record that
  in the run log, with the date.
- A second `/kickoff` immediately after asks nothing and changes nothing except
  the run log.
- Print the next step:
  - a stage stopped part-way: `/kickoff` to resume
  - done: present the first features' specs for approval
    (`spec-driven-development` § _Approval is recorded_), then `/build auto`
    (bootstrap Phase 3)

  If questions remain open, also print which ones and what they block.
