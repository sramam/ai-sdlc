# What did not work — and what to do instead

Lessons from an earlier project, kept as the rule each one produced. Ordered
roughly by cost.

## 1. The root agent file became a history book

- **Instead:** keep the root file under about 200 lines of imperative rules.
  Put the story in the PR or ADR that made the rule. Enforce anything that
  matters with a hook, gate or pattern check, so reading is not the control.
  A root file that carries every rule's incident is loaded on every turn and
  its rules are still missed.

## 2. Hand-written database fakes

- **Instead:** PGlite from day one, plus a pattern check that refuses fakes
  ([testing.md](testing.md)). A hand-written fake grows, and hides product
  bugs the real database would have shown.

## 3. Two trackers and a sync engine

- **Instead:** one source of truth: the plan in the repository
  ([plan-and-requirements.md](plan-and-requirements.md)), with status derived
  from git. If a client forces an external tool, the sync is **one-way,
  observe-don't-remember, idempotent**; "a second run reports zero changes" is
  the completion criterion; never use name matching as the link, use a
  dedicated field. A two-way sync needs custom fields, roll-ups, forward-only
  status rules and a schedule, and each one broke.

## 4. Shared mutable environments

- **A shared dev database.** Instead: a database per checkout
  (`pnpm db:local`, [environments.md](environments.md)). One branch's
  half-finished migration drifts everyone, and the ORM's remedy is to reset
  the shared database.
- **A shared CI database with a concurrency group.** Instead: per-run
  isolation, which PGlite gives for free. Queued runs cancelled by later
  arrivals render as failures.

## 4b. Hosted CI as the default

- **Instead:** local CI is the default and records its verdict as a commit
  status; Actions is opt-in ([BOOTSTRAP.md](BOOTSTRAP.md), _Defaults_). Hosted
  CI costs money per agent pushing, paces the work with waits, and reads its
  own outages as red builds.

## 5. Squash merges

- **Instead:** disable "Allow squash merging" on the repo from day one. Making
  a mistake unavailable beats documenting it. A squash loses the per-commit
  trailers.

## 6. Branch protection assumed, not available

- **Instead:** check the GitHub plan in `/kickoff` (topic 5, budget), and add
  a `pre-push` hook either way, since it also covers people who are not using
  the web UI. Rulesets on private repos are a paid feature, and direct pushes
  to the integration branch go unnoticed without them.

## 7. Defined but undriven state machines

- **Instead:** a pattern check over every event, requiring a sender. Treat
  creation as a transition, with no default on the status column. A machine
  that is declared, tested and diagrammed, and that nothing sends events to,
  leaves records in their first state forever.

## 8. Stored derived state

- **Instead:** derive on read, or re-assert on every run. A status stamped
  once drifts.

## 9. Visual-diff journeys, before their conditions were understood

- **Instead:** ship the machinery with the conditions built in: one warm
  checkout, a recording lock inside the command, routes pre-warmed, contended
  runs discarded, a spurious-mask check, a delta report, and Git LFS
  ([testing.md](testing.md)). Run without them, learning passes contend with
  each other, a red pass still writes masks, and recordings land in git.

## 10. Agent review hooks that blocked on their own blindness

- **Instead:** fail open on _could not ask_, use a sentinel `BLOCK:` line, and
  approve with exactly one line. A reviewer with no tools blocks every edit,
  and one judged on tone blocks an approval that mentions a dismissed concern.

## 11. Smaller traps worth one line each

- Do not name scripts after pnpm subcommands: `pnpm doctor` runs pnpm's
  built-in, silently.
- Use a fixed commit trailer; a model name in it changes mid-session.
- Handoffs gitignored _and_ written inside worktrees die with the worktree.
- Parallel subagents without worktree isolation share one HEAD.
- `vitest env: {}` is not hermetic.
- Verify that a coverage gate can fail ([testing.md](testing.md) § _Coverage_).
- A lazy `Proxy` needs a `has` trap, or `"handler" in auth` is false and every
  sign-in with it.
- `cmd | tail` reports `tail`'s exit code.
- Never hand-type a migration timestamp; never edit an applied migration, not
  even its comment, because the checksum changes.
- `Closes #1, #2` closes only #1. A keyword inside a negation or a quotation
  still fires.
- Drop a handoff warning once it has stopped mattering, or it is copied
  forever.
- Release waiting agents one at a time; a simultaneous "all clear" recreates
  the contention it was meant to end.
- Force capture in seeds: a seed driving real jobs on a real email transport
  sends.
- Use captured real fixtures: faker-generated addresses fail the product's own
  validation.
- An index on `[tenantId, x]` cannot serve a lookup by `x` alone, and the
  superlinear query hides on small data.

## What worked better than expected

Kept here so the list above does not read as "it all went wrong":

- the pattern check
- PGlite
- worktree-per-agent with its guards
- `Progress:` blocks feeding progress reports
- `/land`
- the three-answer discipline
- the port/binding split, which paid for itself when the MCP and agent tooling
  arrived
- capture transports
- passwordless auth with a dev-session helper
