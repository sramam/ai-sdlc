---
name: land
description: Takes a committed branch all the way to dev by running `pnpm land` — the only merge path agents have. Run it in the background; it checks, pushes, runs local CI, opens the PR, merges with a merge commit, and gives the merge commit its own local-ci status. It is the one skill other skills may hand work to, because it takes no lock.
---

# Land

**Checklist:**

1. The branch is committed, the tree is clean, and it is not `dev`.
2. `origin/dev` is an ancestor: if not, `git merge origin/dev` and resolve
   (verify any resolved conflict by substance against the original commits).
3. The branch carries `Progress: <ITEM-ID> …` (and `Closes:` on the finishing
   commit) or `No-Item: <reason>` (grammar: `docs/kit/hooks.md`).
4. **Run `pnpm land` in the background** (a sub-agent or a background shell),
   and keep working with the user. Report its result when it arrives; never
   assume it.

`pnpm land` (`tooling/ci/src/land.mts`) is the only way an agent merges.
`.claude/settings.json` denies the raw routes (`gh pr merge`, pushing to `dev`,
`staging` or `main`, `--no-verify`, force-pushes), so there is nothing to
remember and nothing to skip.

## What `pnpm land` does, in order

1. Refuses on an integration branch, a detached HEAD or a dirty tree.
2. Fetches, and refuses unless `origin/dev` is an ancestor of `HEAD`. It never
   merges `dev` in by itself.
3. Checks the trailers over `origin/dev..HEAD`. A branch touching
   `docs/requirements/` must contain nothing else, **except the discovery
   branch** (`x-000-…`).
4. Pushes, then runs `ci:local` on the pushed SHA, which posts `local-ci`.
5. Opens or reuses the PR into `dev`, with a body listing the `Progress:` and
   `Closes:` lines.
6. Re-checks that the PR is still open **into `dev`**, that its head is the
   tested SHA, and that `origin/dev` has not moved. If any changed (a PR
   retargeted to another base included), it stops and asks for a re-run.
7. Merges with a **merge commit** (`gh pr merge --merge --match-head-commit
<tested SHA>`, so GitHub itself refuses a head that moved after the
   re-check), deleting the branch
   **only** when it carries `Closes:`. A partial PR keeps its branch, so the item
   still reads as claimed.
8. Fetches and runs `ci:local --sha origin/dev`, so the merge commit has its own
   `local-ci` status (content checks reused from the cache, history checks re-run).
   Promotion relies on this status.

Exit codes: 0 landed, 1 refused or failed, 2 could not ask.

## Overrides

`--allow-unknown` is for a step that **could not run** (a missing tool or
credential), only when the author explicitly allows it. The override is posted
under a separate status context, `local-ci/allow-unknown`, and `local-ci`
itself stays unset. A gate that requires `local-ci` therefore never accepts an
override.

## If it stops

- **Red CI:** report the failing steps and the log path it prints. Do not decide
  a failure is "unrelated".
- **Head or base moved:** merge `origin/dev` again if needed, then re-run.
- **PR retargeted:** set its base back to `dev` (`gh pr edit <n> --base dev`)
  and re-run. Land never merges into anything but `dev`.
- **Merged, but the dev-tip status failed:** the merge landed. Re-run the
  `ci:local --sha origin/dev` command it prints.

## Where this stops, deliberately

- It may not merge red, and may not decide a real failure is "unrelated".
- It may not release anything to QA.
- It does not choose the merge order of dependent PRs. Ask.
