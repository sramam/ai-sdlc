# @ai-sdlc/ci

`ci:local`: tests a snapshot of a commit (a shared clone in `.ci-local/run-<sha>/`), runs the steps from `sdlc.config.ts` in a scrubbed environment, and posts a `local-ci` commit status.

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`. A project that needs different behaviour replaces the module and lists it in `sdlc.config.ts` `modules.replaced` (docs/kit/starter-repo.md).
