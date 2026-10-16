# Handoff

A handoff is not a progress report. A progress report is for executives and is
committed. A handoff is for the **next working session**: branch positions, the
next move, and the traps that are expensive to rediscover. It is **gitignored**.
Everything durable in it already lives in git, the plan (`docs/plan/`, `pnpm plan:status`) or `AGENTS.md`.

## Instructions

### 0. Where it goes

```bash
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
FILE="$MAIN/docs/handoffs/$(date +%F)-$(git branch --show-current | tr / -).md"
```

Always write to the **main checkout**. A file inside a worktree dies with the
worktree. If the write is refused, **say the handoff was not written**, and do
not print the pickup line.

Same branch on the same day: supersede the existing file. Different branches:
leave the other files alone.

### 1. Facts come from git, not memory

- `git status`, `git log --oneline origin/dev..HEAD`, ahead/behind counts
- the open PR, if any (`gh pr view --json number,state,url`)
- `git worktree list`, and which worktree is this session's
- the branch's AI spend: `pnpm usage spend --format branch-json --period 30days`,
  the row whose `branch` is this one (API-equivalent cost, this machine only;
  `could not ask` if the command fails, never a zero)

### 2. Four sections

1. **Where things are**: branch, commits not on dev, PR state, `local-ci` status on the tip (read
   from the API), and the branch's AI spend so far
2. **Next move**: one concrete first command
3. **Traps**: things that cost time this session and will cost it again
4. **Open**: each item is _acted on, given an owner and a date, or dropped_.
   Never copy forward an inherited warning you cannot vouch for today. Link the
   OTel trace of anything left broken (telemetry recipe).

### 3. Verify, then say where it is

Re-read the file. Check that every SHA and branch it names exists. Then print
its path. The next session's `pnpm bootstrap` lists the newest handoffs, and
that session picks them up ([pickup.md](pickup.md)) before any work.
