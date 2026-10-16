# What did not work — and what to do instead

Lessons from an earlier project, kept as the rule each one produced.

## 3. Two trackers and a sync engine

- **Instead:** one source of truth: the plan in the repository
  ([plan-and-requirements.md](plan-and-requirements.md)), with status derived
  from git. If a client forces an external tool, the sync is **one-way,
  observe-don't-remember, idempotent**; "a second run reports zero changes" is
  the completion criterion; never use name matching as the link, use a
  dedicated field.

## 7. Defined but undriven state machines

- **Instead:** a pattern check over every event, requiring a sender. A machine
  that is declared, tested and diagrammed, and that nothing sends events to,
  leaves records in their first state forever.

## 11. Smaller traps worth one line each

- Do not name scripts after pnpm subcommands: `pnpm doctor` runs pnpm's
  built-in, silently.
- A lazy `Proxy` needs a `has` trap, or `"handler" in auth` is false and every
  sign-in with it.
- `cmd | tail` reports `tail`'s exit code.
- `Closes #1, #2` closes only #1. A keyword inside a negation or a quotation
  still fires.
- Drop a handoff warning once it has stopped mattering, or it is copied
  forever.
- Release waiting agents one at a time; a simultaneous "all clear" recreates
  the contention it was meant to end.
