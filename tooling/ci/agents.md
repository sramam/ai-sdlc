@ai-sdlc/ci: `ci:local`: tests a snapshot of a commit (a shared clone in `.ci-local/run-<sha>/`), runs the steps from `sdlc.config.ts` in a scrubbed environment, and posts a `local-ci` commit status.

- It never merges; it refuses a branch behind `origin/<integration>`.
- Two runs on the same SHA share a snapshot directory; do not run them concurrently.
