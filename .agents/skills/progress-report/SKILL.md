---
name: progress-report
description: Writes docs/progress/YYYY-MM-DD.md for the window since the last report, from git log Progress: blocks and the AI usage codeburn reads from the agents' local logs. Never rewrites an existing report. Use on the cadence in sdlc.config.json, or when asked what shipped, what it cost, or what is blocked.
---

# Progress Report

It can be generated because every commit body ends with a `Progress:` block, so
`git log` reconstructs the window without opening anything else.

## Instructions

1. **Find the window**: from the newest existing `docs/progress/[0-9]*.md` (not the README) to now.
   For the first report, the window starts at the project's first commit. If
   today's report exists, stop. **Never regenerate a report**: it is a record of
   what was known then.
2. **Gather before summarising:**
   - `git log --since=<start> --format='%H%n%B' origin/dev`, keeping only the
     `Progress:` trailers
   - items closed in the window (`Closes:` trailers on `origin/dev`), items
     added, and questions asked and answered (`git log` on `docs/plan/`)
   - a `pnpm plan:status` snapshot, by milestone, journey and persona
   - ADRs added in the window
   - **AI usage** for the window, every checkout and worktree of this
     repository:
     - `pnpm usage report --format json --from <start> --to <today>`: the total
       cost, tokens, and cost per model
     - `pnpm usage spend --format branch-json --from <start> --to <today>`:
       cost per branch, which names the item it built (branches are item IDs)

     If either fails, the section says _could not ask_ and why, never zero.
3. **Write five sections, in this order:**
   - **Shipped**: by feature and persona, citing item IDs and PRs
   - **Decided**: ADRs and process decisions
   - **AI usage**: the total, the top items by cost, and any item whose cost is
     out of line with its estimate. Label it _API-equivalent cost, this
     machine's logs only_: codeburn prices tokens at today's API rates (not a
     subscription bill), and reads only this machine's agent logs
   - **Cost a day**: what broke, how it was found, what now prevents it. This is
     the section that makes the report worth reading.
   - **Open**: open `Q-` questions ranked by the work they block, and unclaimed
     critical-path items
4. **Promote** (docs/kit/memory.md): for each _Cost a day_ entry, check that its
   lesson is written where it will be read (guardrails, `AGENTS.md`, a package
   `agents.md`, an ADR) and guarded if it can be. Ask whether every project would
   want it; if so, fix it here (the project owns the code) and draft the same
   change for the `ai-sdlc` registry, which other projects take with `pnpm sdlc update`.
5. **Verify** that every PR, item ID and SHA cited exists.
6. **Land** it like any change: on its own branch, with a
   `No-Item: progress report` trailer, via `pnpm land`.

A report that only lists features is a changelog, and the changelog already
exists: it is the commit log.
