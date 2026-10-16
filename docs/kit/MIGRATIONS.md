# Migrations

What a project has to do by hand when it takes a starter release. `pnpm
sdlc:update` prints every section newer than the project's `.sdlc-version`, so
write each one for the person reading it in the terminal: what changed, what to
do, and how to tell it worked.

One `## x.y.z` section per release that needs anything done, newest last. A
release that needs nothing gets no section. When a release changes the format
of `sdlc.config.json`, it raises `configVersion`, sets the manifest's
`minConfigVersion`, and its section says how to convert the file —
`sdlc:update` refuses a project behind it and prints that section.

## 0.1.0

Initial release. Nothing to migrate.

- `sdlc.config.json` is declarative JSON (`configVersion` 1), validated by
  `tooling/core/src/config.mts`. A project still holding the `sdlc.config.ts`
  of an earlier snapshot converts it by hand: the same keys, as JSON, with the
  comments dropped (examples are in `tooling/core/README.md`). Then delete the
  `.ts` file and remove it from `tsconfig.json`'s `include`.
- `.sdlc-version` records the starter release applied; `sdlc:update` writes it.
- A _census_ is now called a **pattern check** (`docs/kit/principles.md` §6).
  A project holding an earlier snapshot renames its imports:
  `tooling/journeys/src/census/census.mts` is now
  `tooling/journeys/src/pattern-check/pattern-check.mts`, exporting
  `journeyPatternCheck`, `snapshotPatternCheck`, `directoryPatternCheck`,
  `personaPatternCheck`, `specPatternCheck`, `isolationPatternCheck` and the
  type `PatternCheck`; `floorProseCensus` in `@ai-sdlc/coverage` is
  `floorProsePatternCheck`. Renaming the project's own
  `e2e/journeys.census.test.ts` to `e2e/journeys.pattern-check.test.ts` is
  optional. It worked when `pnpm exec vitest run` passes and `grep -rn
census tooling/ e2e/` finds nothing.
