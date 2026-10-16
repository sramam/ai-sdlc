# ai-sdlc

A starter repository for software built by AI agents and people together. It
carries the development process (skills, hooks, guards, local CI, the plan, the
journey testing machinery and the docs) and **no product code**. Apps and
packages are decided during kickoff and created from recipes.

## Start a project

Needs Node 24+, pnpm 10, the `gh` CLI and, for Cloudflare, `wrangler`.

```bash
gh auth login && wrangler login
gh repo create sramam/<name> --template sramam/ai-sdlc --private --clone
cd <name>
git remote add starter https://github.com/sramam/ai-sdlc.git
pnpm install && pnpm sdlc:init   # creates dev; applies the merge ruleset where the plan allows
```

Then tell your agent: _"Read `docs/kit/BOOTSTRAP.md` and follow it. Start with
`/kickoff`."_

## How a project moves

```
/kickoff ─▶ /idea ─▶ /kickoff ─▶ /plan ─▶ /plan next   (every session after)
 how,        what:     stack,      items,     claim ▶ worktree ▶ build
 1st pass    BRD/PRD   apps, ADRs  foundation    ▶ commit ▶ pnpm land
                                   first
later requests: /add-requirement        to production: pnpm promote:staging, :prod
```

- **Requirements** (`docs/requirements/`) change only through `/kickoff`,
  `/idea` or `/add-requirement`. Every architecture choice and plan item traces
  back to one. A new technology is decided by you, through a pros-and-cons
  dialog.
- **The plan lives in the repo** (`docs/plan/`), with stable IDs for personas,
  features, requirements, journeys and items. Status is derived from git. There
  are no GitHub Issues or Projects.
- **Every agent session works in its own worktree**, forked from `dev`, and
  claims its item first (`pnpm claim <ID>`), so two agents never build the
  same thing.

## Architecture

Five layers. Each exists because the one above it drifts when nothing enforces
it.

| layer                | where                                                | what it does                                                                                                                                                        |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The kit**          | `docs/kit/`                                          | The specification and its reasons: principles, the SDLC, testing, security, UX, AI, environments, recipes. [Start here](docs/kit/README.md)                         |
| **Skills**           | `.claude/skills/`                                    | Procedures an agent follows: `kickoff`, `idea`, `add-requirement`, `plan`, `land`, `handoff`, `pickup`, `progress-report`, `release`, the journey and review skills |
| **Fast enforcement** | `.husky/`, `.claude/settings.json`, `tooling/guards` | Caught in seconds: commit trailers, the requirements lock, worktree rules, refused pushes to `dev`/`staging`/`main`, denied merge and force-push commands           |
| **The merge gate**   | `tooling/ci`, `sdlc.config.json`                     | `pnpm ci:local` runs every check in a clean snapshot and posts a `local-ci` commit status. `pnpm land` is the only way to merge. GitHub Actions stays off           |
| **Shared tooling**   | `tooling/*`                                          | One replaceable workspace package per module (below). A project can take one over by listing it in `modules.replaced`                                               |

Two ideas run through all of it:

- **Every check has three answers:** yes, no, and _could not ask_. The third is
  never reported as a pass.
- **A list that matters is counted by a test** (a census), not kept by hand.

### Tooling modules

| module     | gives you                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `core`     | config loading and validation, the git command parser, port probing, shared exec                              |
| `guards`   | the git and Claude Code hooks: trailers, worktree rules, provenance, the requirements lock                    |
| `plan`     | `plan:check` (a staged census: requirements → plan → build), `plan:status`, `claim`, the sources manifest     |
| `ci`       | `ci:local` and `land`                                                                                         |
| `setup`    | `sdlc:init`, `bootstrap`, `accounts:check`, `sdlc:update`                                                     |
| `localdb`  | a PGlite Postgres per worktree, snapshotted before every migrate or reset                                     |
| `seed`     | deterministic demo data, opt-in per app                                                                       |
| `journeys` | Playwright journeys with screenshots, diffs and learned masks. Recording runs three passes; testing runs one  |
| `coverage` | merged coverage, per-package floors, the published report                                                     |
| `promote`  | `promote:staging`, `promote:prod`, `rollback`, `release`: fast-forward only, green SHA required, smoke-tested |
| `security` | secrets (built-in, plus trufflehog or gitleaks), dependency audit, licences, install scripts, release age     |

### Configuration and updates

- `sdlc.config.json` is the one file a project edits to configure the tooling.
  CI reads it from `origin/dev`, never from the branch under test.
- `starter-manifest.json` lists what the starter owns. `pnpm sdlc:update` pulls
  newer starter versions into a project, and lessons a project learns flow back
  here ([memory.md](docs/kit/memory.md)).

## Everyday commands

```bash
pnpm plan:status                     # where the plan stands
pnpm claim <ID>                      # take an item before starting it
pnpm db:local start                  # this worktree's database (also snapshot, restore, reset)
pnpm test && pnpm ci:local           # the gate, locally
pnpm land                            # verify, open and merge the pull request
pnpm journeys:test                   # end-to-end journeys
pnpm security:scan
```

## Status

All eleven modules, sixteen skills and the recipes are built, with over a
thousand tests passing. Fixes from a second external review are in progress.
Not yet exercised: `ci:local`'s container mode, a live OpenRouter call, and the
authorization engines inside a deployed Worker.
