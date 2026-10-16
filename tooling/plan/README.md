# @ai-sdlc/plan

The plan in the repo: parsing `docs/requirements/` and `docs/plan/` (the markdown conventions are in the header of `plan-lib.mts`), `plan:check` (the staged pattern check), `plan:status` (derived from git), `claim` (an atomic claim on a work item) and `item-check`.

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`. A project that needs different behaviour replaces the module and lists it in `sdlc.config.json` `modules.replaced` (docs/kit/starter-repo.md).

## Stages (`plan:check`)

Each stage includes the ones before it; the default is the highest reached.

| stage           | reached when                                                                                       | adds                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pre-discovery` | no discovery output exists (the starter as shipped)                                                | ID checks over the plan, and a `NOT STARTED` row: passes, and never reads as "discovery done" |
| `requirements`  | any discovery output exists, or `--stage requirements`                                             | every required output, the review verdict, the requirement pattern check                      |
| `plan`          | `docs/plan/README.md` holds a written plan                                                         | the verdict is ready to plan; the plan pattern check                                          |
| `build`         | a workspace package outside `tooling/` exists (`apps/*`, `packages/*`), or the plan README says so | trailers name items; every dependency is accounted for                                        |

**Required discovery outputs** (in `docs/requirements/`): `brd.md`, `prd.md`, `personas.md` (≥1 persona), `features/` (≥1 feature with ≥1 requirement), `journeys.md` (≥1 journey), `glossary.md`, `access-model.md` (a `Tenancy:` that is not `open`), `domain-model.md`, `ux.md`, `technology.md`, `review.md`. A missing one **fails**; `vacuous` is only for genuinely optional checks. `project-brief.md`, `README.md` and `sources/` do not count as discovery having started.

## Formats this package reads

**The verdict**, one line in `review.md`:

```
Verdict: ready-to-plan
```

One of `ready-to-plan`, `ready-with-assumptions`, `ready-pending-decisions`, `not-ready`. The requirements stage needs `ready-pending-decisions` or better; the plan stage needs `ready-to-plan` or `ready-with-assumptions`. Absent, malformed or doubled fails.

**Dependencies**, in `docs/adr/*.md` or `docs/architecture.md`:

```
Dependencies: typescript, `@types/node`, @scope/pkg
```

Comma-separated, backticks optional, several lines accumulate. Only these lines account for a package; prose does not. All four dependency fields of the root and every workspace `package.json` (tooling included) are read; workspace links are exempt.

**Declaring the build stage**, in `docs/plan/README.md`: a line `Stage: build`.

**A claim** (`pnpm claim <ID> [--session <id>]`) is a remote branch named exactly the lower-cased item ID (`f03-012`), created through the GitHub API on a commit over `origin/<integration>`:

```
Claim: F03-012

Claimed-By: <session id, else git config user.email>
Claimed-At: <ISO 8601 time>
```

A second claim is the same ref and exits 3, naming the holder. It prints the commands to fetch the branch and create the worktree, and runs neither. `plan:status` takes the claim time from `Claimed-At:` (else the branch's oldest commit not on the integration branch); a claim is stale when it is older than `claimStaleDays` **and** nothing on it, nor a `Progress:` on the integration branch, is newer.

**`item-check`** reports what touched an item's paths in `<commit that added the item>..HEAD`: topology, not dates.
