# Pickup

**A handoff is a report, not a fact.** It was true when written, and commits may
have landed since. Where the handoff and the repository disagree, the
disagreement is the finding: something happened that nobody recorded.

## Instructions

1. **Find them.** `$MAIN/docs/handoffs/`, where
   `MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")`
   (the main checkout). Take every file for the newest date, or only the named
   branch. If there are none, that is normal on a fresh clone or a cloud session.
   Fall back to `git log` and `pnpm plan:status`.
2. **Check each claim against the repository:**
   - branch exists; its tip matches; ahead/behind of `origin/dev`
   - PR state and the `local-ci` commit status, read from `gh api`
   - worktrees named still exist (`git worktree list`)
   - plan items named: is each still not done (`pnpm plan:status`), still claimed
     by this branch, and has its code moved since (`git log` on the paths it names)?
3. Ask of every inherited warning: is it still true, and is it still
   worth carrying? Propose dropping any warning that nobody has acted on across
   several handoffs.
4. **Is anything due?** Using the cadence in `sdlc.config.json`, check whether a
   progress report or a `/plan sync` is due, and whether any claims are stale.
   Say so.
5. **Report before doing anything**: per handoff, _confirmed_, _changed since_
   (with the commits), _could not check_. Then the recommended first move.

Do not start work until the report is out.
