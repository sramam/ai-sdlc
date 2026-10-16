# @ai-sdlc/promote

Three scripts, run by a person: promotion, rollback and release tags. They do the remembering; whether to promote or name a build stays a person's decision. Every external call (git, gh, the deploy and smoke commands, the smoke GET) goes through an injected `Exec`, so the tests use scripted fakes and temporary git repositories, never a real GitHub or vendor CLI.

## `promote <env> [--sha <ref>] [--dry-run] [--yes]`

Moves an environment forward by fast-forward only, following docs/kit/environments.md § _Deploying, with no hosted CI_. The environment's `branch` is promoted from the branch before it in `integration → staging → production`, so staging takes the integration tip and production takes the staging tip. `--sha` picks an earlier commit, which must be on that source branch.

One line per step, each `ok`, `REFUSED`, `FAILED` or `COULD NOT ASK`:

1. **config**: the environment is declared.
2. **clean**: the tree has no uncommitted changes.
3. **fetch**: `git fetch origin`.
4. **source**: `origin/<source>`, or `--sha` when it is on it.
5. **local-ci**: refuses unless that SHA carries the commit status `local-ci` = `success` (`gh api repos/{owner}/{repo}/commits/<sha>/status`). `local-ci/allow-unknown` is an override, not a pass, and is refused. There is no override here.
6. **ff**: refuses unless `origin/<target>` is an ancestor of the SHA. It never merges and never opens a PR into `main`.
7. **push-check**: `git push --dry-run` of the exact push from step 13. The pre-push hook and the remote answer before anything changes. Both this push and step 13's are handed to the hook first (below); a handoff that cannot be written is could-not-ask.
8. **approval**: `requiresApproval` prints the plan and stops unless `--yes` is given. `--dry-run` stops here with exit 0.
9. **checkout**: `git clone --shared` into a temporary directory, detached at the SHA. The working tree is never what gets deployed.
10. **install**: `pnpm install --frozen-lockfile` in the checkout, when it has a lockfile.
11. **migrate**: the environment's `migrate` command, against its direct connection. A failure stops before deploy.
12. **deploy**: the environment's `deploy` command, in the checkout.
13. **push**: `git push origin <sha>:refs/heads/<target>`. Never forced.
14. **smoke**: the `smoke` command, then `GET smokeUrl`, expecting a status below 400. A failure is loud and names the rollback.

Commands run through `sh -c` with `PROMOTE_ENV`, `PROMOTE_SHA` and `PROMOTE_BRANCH` added to the environment. Exit codes: 0 promoted (or a dry run), 1 refused or failed, 2 could not ask.

## `rollback <env>`

Runs the environment's `rollback` command. The schema stays forward: a rollback moves the code back and undoes no migration, which is why migrations are additive first. The git branch is not moved either, so it names a newer commit than the environment runs until the next promotion.

## `release [--minor|--major|--patch] [--at <ref>] [--yes] [--allow-unknown]`

Gives a commit on `origin/<integration>` (by default its tip) a version tag `<tagPrefix><x.y.z>`.

- **Modes.** With no bump flag it reports. With a bump flag it plans: it prints the tag, the range and the notes, and writes nothing. With `--yes` it creates an annotated tag locally and prints `git push origin refs/tags/<tag>`. It never pushes, and it bumps no `package.json`.
- **Refusals.** It refuses a dirty tree, a commit not on `origin/<integration>`, a tag that already exists, and a version that is not an increase. A newer version on a commit the latest version is not part of counts as not an increase.
- **The `local-ci` gate.** A missing or non-success `local-ci` status is refused. Red has no override. An unknown status (absent, pending, error, only the override context, or GitHub unreachable) is accepted only with `--allow-unknown`, and the tag annotation then says that nobody checked.
- **Notes.** They are the `Progress:`, `Closes:` and `No-Item:` trailers since the previous version in this commit's history, grouped by item ID, with counts of described commits, merge commits and bare commits. Nothing is summarised.

A version says which code. It never says which journeys are testable.

## Configuration

Both sections are optional. Without `environments` there is nothing to promote. Without `release` the tag prefix is `v`. An environment's `branch` must be `branches.staging` or `branches.production`.

```json
{
  "environments": {
    "staging": {
      "branch": "staging",
      "migrate": "pnpm run db:migrate:staging",
      "deploy": "CLOUDFLARE_ENV=staging pnpm exec vite build && pnpm exec wrangler deploy",
      "smokeUrl": "https://staging.example.com/api/health",
      "rollback": "pnpm exec wrangler rollback --env staging"
    },
    "production": {
      "branch": "main",
      "migrate": "pnpm run db:migrate:production",
      "deploy": "CLOUDFLARE_ENV=production pnpm exec vite build && pnpm exec wrangler deploy",
      "smoke": "pnpm run smoke:production",
      "smokeUrl": "https://example.com/api/health",
      "rollback": "pnpm exec wrangler rollback --env production",
      "requiresApproval": true
    }
  },
  "release": { "tagPrefix": "v" }
}
```

The `migrate` command connects to the environment's direct (unpooled) database URL. It reads that from its own environment, never from a value written into this file.

## The pre-push hook

`.husky/pre-push` refuses every update of `dev`, `staging` and `main`, including a SHA that is already on `origin/dev` and a push from a local branch named `dev` or `staging`. Neither proves the commit was approved, migrated, deployed or smoke-tested, which is what this script is for.

So promote hands each push to the hook. Before it, `armPush` (shared.mts) writes `<git-common-dir>/sdlc-promote-handoff` holding `<nonce> <sha> <ref>`, and the push runs with the nonce in `SDLC_PROMOTE_NONCE`. The hook accepts the update only when the nonce, the SHA and the ref all match, and deletes the file either way, so a handoff is good for one push. Promote deletes it after the push too, in case the hook never saw it. `promote.git.test.ts` trips the real hook with every other road: a raw SHA push, named-ref pushes, a guessed nonce, a handoff for another SHA or ref, a replay, a deletion, and a push to `dev`.

It is a guardrail, not a boundary: anything that can write `.git/` and set a variable can forge a handoff. A GitHub ruleset on `staging` and `main` is the stronger layer where the plan offers one (docs/kit/environments.md).

The project's own: it arrives with `pnpm sdlc add promote`; `pnpm sdlc diff promote` shows what changed upstream, and `pnpm sdlc update promote` takes it without overwriting a local edit (docs/kit/registry.md).
