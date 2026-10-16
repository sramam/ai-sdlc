@ai-sdlc/coverage: `coverage` is the one coverage gate, over the merged unit + integration run, with floors from `sdlc.config.json` `coverage.floors`. See README.md.

- One implementation of "what is the coverage": the gate and `docs/quality/coverage.md` both read `coverage-lib.mts`. Never compute a published figure any other way.
- Merge by source location, never by key: @vitest/coverage-v8 numbers branches per run, so the same key is different code in each suite.
- A run that cannot see every suite (`--unit-only`, `--only`) reports and never judges, and may not overwrite a merged report without `--force`.
- Only a green full run stamps `.ci-local/coverage-<fingerprint>` and the report's fingerprint line. Anything a figure depends on belongs in `fingerprintInputs`, or an unchanged-looking tree skips a real change.
- Floors are declared in `sdlc.config.json` and quoted nowhere else; `floor-prose.test-helper.mts` is the pattern check that keeps them out of `docs/`.
- Every external call goes through an injected `Exec`; tests use scripted fakes, plus one real vitest run against a fixture.
