# What did not work — and what to do instead

Ordered roughly by cost.

## 1. The root agent file became a history book

door_nexa's `agents.md` grew to **3,000+ lines** of narrative. Each rule came
with the incident that produced it, the measurements and the table of what it
cost. Every word was true and well argued, and the whole of it was loaded into
every session.

- **Cost:** context and tokens on every turn, and rules buried in stories. Agents
  still missed rules they had "read". The squash rule was broken by a session
  that had read it.
- **Instead:** keep the root file under about 200 lines of imperative rules. Put
  the story in the PR or ADR that made the rule. Enforce anything that matters
  with a hook, gate or census, so reading is not the control.

## 2. Hand-written database fakes

The fake grew to 779 lines and hid five product bugs.

- **Instead:** PGlite from day one, plus a census that refuses fakes. See
  [testing.md](testing.md).

## 3. Two trackers and a sync engine

This one was door_nexa-specific: the client wanted ClickUp. It is recorded only
so nobody recreates it by choice. GitHub issues held the code work and ClickUp
was "the project". That needed:

- a bidirectional mental model
- custom fields the API cannot create
- drop-down read and write that disagree on spelling
- 200 OK responses that did not persist
- a roll-up engine
- forward-only status rules
- a dependency on CI state
- a weekly schedule that overwrote unmerged changes

- **Instead:** one source of truth. Here that is the plan in the repository
  ([plan-and-requirements.md](plan-and-requirements.md)), with status derived
  from git. If a client ever forces an external tool, the sync should be
  **one-way,
  observe-don't-remember, idempotent**. "A second run reports zero changes" is the
  completion criterion. Never use name matching as the link; use a dedicated field.

## 4. Shared mutable environments

- **A shared dev database:** `prisma migrate dev` and `--create-only` still apply
  pending migrations. One branch's half-finished migration drifted everyone, and
  Prisma's suggested remedy was to reset the shared database.
  - **Instead:** a database branch per checkout. Until then, generate migrations
    with `migrate diff --from-schema <origin/dev schema>`, and read the generated
    SQL **from the top**.
- **A shared CI database with a concurrency group:** queued runs were cancelled
  by later arrivals, and rendered as "fail".
  - **Instead:** per-run isolation, which PGlite gives for free.

## 4b. Hosted CI as the default

Every push ran the full suite on GitHub Actions. That had three costs:

- **Money**, which grew with the number of agents pushing
- **Waits**, which paced the work; serialized lanes queued behind each other
- **Outages read as failures**: a billing block and dropped events both looked
  like red builds

The local fallback (`ci:local`), built during an outage, turned out to be
sufficient.

- **Instead:** make local CI the default and record its verdict as a commit
  status. Actions is opt-in ([BOOTSTRAP.md](BOOTSTRAP.md), _Defaults_).

## 5. Squash merges

Squashing turned seven commits into one and lost the `Session:` trailers.

- **Instead:** disable "Allow squash merging" on the repo from day one. Making a
  mistake unavailable beats documenting it.

## 6. Branch protection assumed, not available

The GitHub Free plan returns 403 on rulesets for private repos, so direct pushes
to `dev` went unnoticed for ten days.

- **Instead:** check the GitHub plan in `/kickoff` (topic 5, budget). Add a `pre-push` hook either way, since
  it also covers people who are not using the web UI.

## 7. Defined but undriven state machines

A machine was fully declared, tested and diagrammed, and nothing sent it events.
Delinquency cases never closed after payment. Payouts stayed `PROCESSING`
forever.

- **Instead:** census every event for a sender. Treat creation as a transition,
  with no `@default` on the column.

## 8. Stored derived state

Badge statuses, roll-up statuses and link URLs were stamped once and drifted.

- **Instead:** derive on read, or re-assert on every run.

## 9. Visual-diff journeys, before their conditions were understood

The model is kept: screenshots, learned data-volatile masks, three-pass
recording and one-pass testing. **What cost so much was running it without its
conditions.** Learning passes ran in parallel cold checkouts, a contended pool
slowed pages mid-photograph, a red pass 1 still wrote masks, and 196 MB of
recordings went into git.

- **Instead:** ship the machinery in the starter repo with the conditions built
  in: one warm checkout, a recording lock inside the command, routes pre-warmed,
  contended runs discarded, a spurious-mask check, a delta report, and Git LFS.
  See [testing.md](testing.md).

## 10. Agent review hooks that blocked on their own blindness

Reviewers with no tools, or handed scratch paths, blocked edits. Reviewers that
_approved_ while mentioning a dismissed concern were blocked by tone.

- **Instead:** fail open on _could not ask_, use a sentinel `BLOCK:` line, and
  approve with exactly one line.

## 11. Smaller traps worth one line each

- `pnpm doctor` ran pnpm's built-in, silently, for a year. Do not name scripts
  after pnpm subcommands.
- A model name in commit trailers created inconsistency mid-session. Use a fixed
  trailer.
- Handoffs gitignored _and_ written inside worktrees died with the worktree.
- Parallel subagents without worktree isolation shared one HEAD.
- `vitest env: {}` is not hermetic.
- vitest 4.1 per-glob coverage thresholds were inert.
- A lazy `Proxy` without a `has` trap broke `"handler" in auth`, and every
  sign-in with it.
- `cmd | tail` reports `tail`'s exit code.
- A hand-typed migration timestamp sorted wrong; editing an applied migration's
  _comment_ changed its checksum.
- `Closes #1, #2` closes only #1. A keyword inside a negation or a quotation
  still fires.
- One warning was copied through 18 handoffs after it had stopped mattering.
- A simultaneous "all clear" to six waiting agents recreated the contention it
  was meant to end.
- A seed driving real jobs on a real email transport could send hundreds of
  messages. Force capture in seeds.
- Faker-generated addresses produced data the product's own validation rejects.
  Use captured real fixtures.
- An index on `[organizationId, x]` cannot serve a lookup by `x` alone. A
  superlinear query hid on small data for a year.

## What worked better than expected

Kept here so the list above does not read as "it all went wrong":

- the census pattern
- PGlite
- worktree-per-agent with its guards
- `Progress:` blocks feeding progress reports
- `/land`
- the three-answer discipline
- the port/binding split, which paid for itself when the MCP and agent tooling
  arrived
- capture transports
- passwordless auth with a dev-session helper
