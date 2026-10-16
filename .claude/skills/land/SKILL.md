---
name: land
description: Takes a committed branch all the way to dev. It is the one skill other skills may hand work to, because it takes no lock — checks it is current with origin/dev, pushes, runs local CI (which posts a local-ci status on the pushed SHA), opens the PR, merges with a merge commit, and gives the resulting dev tip its own status so promotion can rely on it
---

# Land

CI is **local** (Actions is off, for cost), so this skill is the gate. **Nothing
merges without a green `local-ci` status on the exact head SHA, and the merge
commit on `dev` gets one too.** The skill does the remembering, not the
judgement; see _Where this stops_. The trailer grammar is in
`docs/kit/hooks.md`.

## 1. Ready

1. **Committed, and not on `dev`.** `git status --porcelain` is empty.
2. **Current**: `git fetch`, then `origin/dev` must be an ancestor of `HEAD`. If
   it is not, `git merge origin/dev`. **`ci:local` never merges by itself**; it
   refuses a branch that is behind.
3. **If a conflict was resolved, verify it by substance.** Compare files and
   diffstat against the original commit(s). A resolved conflict is a change
   nobody reviewed.
4. **The branch names its work**: a `Progress: <ITEM-ID> …` trailer (and
   `Closes:` on the finishing commit), or `No-Item: <reason>`. If it touches
   `docs/requirements/`, it carries `Requirements:` and **contains nothing
   else**. A requirements change is its own branch and PR, landed before the
   code that depends on it. **Exception: the discovery branch (`x-000-…`)**,
   which lands requirements, the project brief, `docs/architecture.md`, ADRs
   and the plan together, because they are decided together.

## 2. Push, then test

5. `git push -u origin HEAD`. GitHub must have the SHA before a status can be
   posted on it.
6. **`pnpm ci:local`**, **in the background** (a sub-agent or a background
   shell), so the conversation is not blocked. It tests a snapshot of the pushed
   head SHA in `.ci-local/run-<sha>/`, and posts `local-ci` on it. Wait for the
   result before step 7, and never assume it. On red, **stop and report**. _Could not run_ holds the merge,
   unless the author explicitly allows it (`--allow-unknown`, which writes the
   override into the status).

## 3. Merge

7. Open the PR into `dev` if none exists (`gh pr create --base dev --body-file
<file>`).
8. **Re-check before merging**: the PR head is still the SHA with the green
   status (`gh api repos/{o}/{r}/commits/<sha>/status`), and `origin/dev` has
   not moved since step 2. If either has changed, go back to step 2.
9. **A merge commit, never a squash**: `gh pr merge <n> --merge`, adding
   `--delete-branch` **only when the PR carries `Closes:`**. A partial PR keeps
   its branch, so the item still reads as claimed.
10. **Give the new `dev` tip its status.** `git fetch`, then run `pnpm ci:local
--sha origin/dev`. Because `dev` did not move (step 8), the merge commit's
    tree is identical to the tree just tested. The fingerprint matches, so it
    posts `local-ci` on the merge SHA in under a second. Promotion relies on
    this status.

There is no local `dev` to sync. Every worktree bases on `origin/dev`, and the
main checkout is never worked in.

## If GitHub Actions has been enabled

Also wait for the hosted checks, and read them through `gh api`. `gh pr checks`
shows _cancelled_ as `fail`, and a job with zero steps never ran.

## Report

What landed, the merge SHA and its `local-ci` status, which items it closed, and
anything left open. If a check could not pass, say which and why, and never
claim the work landed.

## Where this stops, deliberately

- It may not merge red, and may not decide a real failure is "unrelated".
- It may not release anything to QA.
- It does not choose the merge order of dependent PRs. It asks.
