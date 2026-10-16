@ai-sdlc/security: `security:scan` — secrets, deps, licenses, install-scripts, release-age, one line each, exit 0/1/2. Configured by the optional root `security.config.json`. See README.md.

- **Never print a secret's value.** Findings carry file, line and rule; the matched line is used only for allow-list matching and dropped.
- **Test fixtures assemble secret shapes at runtime** (`test-helpers.mts`). A literal sample in a source file trips the repository's own scan; `secrets.test.ts` scans this package's sources to keep it so.
- **Could-not-run is never a pass.** A registry error, a missing install or a missing pnpm holds the verdict (exit 2). Do not map it to pass to make a run green.
- **Fix a false positive by tightening the rule**, with a near-miss case in `nearMisses()`. Allow-list only a value that is genuinely not a secret, with its reason.
- **Exceptions only shrink.** An allow-list, ignore or exception entry that no longer matches anything fails its check; so does an `onlyBuiltDependencies` entry without a script.
- **External engines are optional.** gitleaks/TruffleHog absent is not a failure; a crash is said in the output, never silently dropped. TruffleHog runs with `--no-verification`: verifying would send candidates to vendors.
- Every external call goes through an injected `Exec`; tests use `scriptedExec`.
