---
name: handoff
description: Writes docs/handoffs/YYYY-MM-DD-<branch>.md into the main checkout — how the next working session picks up, from git and the plan. Run last, after the final commit.
---

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

### 2. Four sections

1. **Where things are**: branch, commits not on dev, PR state, `local-ci` status on the tip (read
   from the API)
2. **Next move**: one concrete first command
3. **Traps**: things that cost time this session and will cost it again
4. **Open**: each item is _acted on, given an owner and a date, or dropped_.
   Never copy forward an inherited warning you cannot vouch for today. Link the
   OTel trace of anything left broken.

### 3. Verify, then print how to pick it up

Re-read the file. Check that every SHA and branch it names exists. Then print:

```
/pickup <branch>
```
