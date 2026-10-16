@ai-sdlc/plan: The plan in the repo: parsing `docs/requirements/` and `docs/plan/` (the markdown conventions are in the header of `plan-lib.mts`), `plan:check` (the staged census), `plan:status` (derived from git), `claim`, `item-check`.

- The skills that write requirements must follow the conventions `plan-lib.mts` parses — including the exact `Verdict:` line in `review.md` and the `Dependencies:` line in ADRs (README.md § Formats).
- Status is never stored; it is derived from `Closes:`/`Progress:` trailers and claim branches.
- `pre-discovery` passes with a `NOT STARTED` row. Never report it as discovery being done; `--stage requirements` is what discovery must pass.
- A missing required document fails. Do not make a check vacuous because its subject is absent unless that subject is genuinely optional.
- A claim branch is exactly the lower-cased item ID, made by `pnpm claim` (GitHub API, atomic). A `<id>-<slug>` branch is not a claim. Claim time comes from the claim commit's `Claimed-At:`, never from the branch tip's date.
- Anything that reads git history by range uses topology (`A..B`), never `--since`.
- Every external call in `claim.mts` goes through an `Exec`; test it with `scriptedExec`, never a real remote.
