@ai-sdlc/plan: The plan in the repo: parsing `docs/requirements/` and `docs/plan/` (the markdown conventions are in the header of `plan-lib.mts`), `plan:check` (the staged census), `plan:status` (derived from git), `item-check`.

- The skills that write requirements must follow the conventions `plan-lib.mts` parses.
- Status is never stored; it is derived from `Closes:`/`Progress:` trailers and live branches.
