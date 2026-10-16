@ai-sdlc/ci: `ci:local` tests a snapshot of a commit and posts a commit status; `land` takes a committed branch to the integration branch. See README.md.

- `ci:local` never merges; it refuses a branch behind `origin/<integration>`.
- The steps come from `sdlc.config.json` on `origin/<integration>` (`deps.loadConfigAt`), never from the commit under test. Do not read the CI definition from the snapshot.
- `--container` mounts only the snapshot and passes variables by name. Never add a host path mount or put a variable's value in argv.
- The cache key covers the tree, the CI definition, the toolchain, the lockfile and `ci-local.mts`. Changing what a pass depends on means adding it to `cacheKey`, or a stale pass is reused.
- A step that reads a commit range is a history check (`HISTORY_STEPS`, `--range`, or `history: true`). It runs on every invocation, without `pnpm install` on a cache hit, so it must need only node and git.
- Concurrent runs are safe: a per-SHA lock serialises them, and each run has its own `run-<sha>-<random>/` that only it removes.
- Only a real pass posts `local-ci`. An `--allow-unknown` override posts `local-ci/allow-unknown`. Never make a gate accept the override context.
- `land` never squashes, rebases or forces. It merges only after re-checking that the PR head is the tested SHA and `origin/<integration>` has not moved. Every external call goes through an injected `Exec`, so tests use scripted fakes.
