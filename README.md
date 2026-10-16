# ai-sdlc

A registry for software built by AI agents and people together, in the way
shadcn/ui is one: a project takes the development process (skills, hooks,
guards, local CI, the plan, the journey machinery, the docs) and the reference
code it needs **as source files it then owns**. It carries **no product code**;
apps and packages are decided during kickoff.

## Start a project

Needs Node 24+, pnpm 10, git, the `gh` CLI and, for Cloudflare, `wrangler`.

```bash
pnpm dlx github:sramam/ai-sdlc#v0.1.0 init my-app   # base files, pnpm install, the first commit
cd my-app
gh auth login && wrangler login
gh repo create <owner>/my-app --private --source . --push
pnpm sdlc:init                                      # creates dev; settings and merge rules
```

Then tell your agent: _"Read `docs/kit/BOOTSTRAP.md` and follow it. Start with
`/kickoff`."_ Kickoff decides which modules and recipes the project needs, and
the foundation items add them:

```bash
pnpm sdlc list                        # every item, and which are installed
pnpm sdlc add journeys coverage       # modules
pnpm sdlc add app-tanstack-workers    # a recipe, with what it requires
```

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

**Base and items.** `init` gives a project **base**: the kit, the core skills,
the hooks and guards, and the `core`, `guards`, `plan`, `ci` and `setup` modules.
Everything else is an **item** it adds when it needs it: a **module**
(`journeys`, `localdb`, `seed`, `coverage`, `promote`, `security`, each with its
skills) or a **recipe** (reference code for `packages/api`, `apps/web`,
authorization, LLM access, UI and more). `registry.json` lists them all.

**A project owns everything it was given.** Every item arrives as plain files,
with its tests, so an agent can read it, change it to fit, and fix it. Nothing
is a dependency and nothing is "upstream-owned". `sdlc.lock.json` records the
hash of each file as copied, so `pnpm sdlc diff <item>` can tell a local edit
from an upstream change, and `pnpm sdlc update <item>` brings upstream fixes in
deliberately: it applies a change only to a file still as it was copied, and
lists the rest, with the upstream diff, for an agent to fold in by hand.
[docs/kit/registry.md](docs/kit/registry.md) has the details.

Inside a project, five layers. Each exists because the one above it drifts when
nothing enforces it.

| layer                | where                                                | what it does                                                                                                                                               |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The kit**          | `docs/kit/`                                          | The specification and its reasons: principles, the SDLC, testing, security, UX, AI, environments, recipes. [Start here](docs/kit/README.md)                |
| **Skills**           | `.claude/skills/`                                    | Procedures an agent follows: `kickoff`, `idea`, `add-requirement`, `plan`, `land`, `handoff`, `pickup`, `progress-report`, the review skills, and modules' |
| **Fast enforcement** | `.husky/`, `.claude/settings.json`, `tooling/guards` | Caught in seconds: commit trailers, the requirements lock, worktree rules, refused pushes to `dev`/`staging`/`main`, denied merge and force-push commands  |
| **The merge gate**   | `tooling/ci`, `sdlc.config.json`                     | `pnpm ci:local` runs every check in a clean snapshot and posts a `local-ci` commit status. `pnpm land` is the only way to merge. GitHub Actions stays off  |
| **Shared tooling**   | `tooling/*`                                          | One workspace package per module (below), the project's to change                                                                                          |

Two ideas run through all of it:

- **Every check has three answers:** yes, no, and _could not ask_. The third is
  never reported as a pass.
- **A list that matters is counted by a test** (a pattern check), not kept by
  hand. `registry.json` is one: every file here belongs to one item, and each
  item's imports and dependencies are checked against what it declares.

### Modules

| module     | item   | gives you                                                                                                        |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `core`     | base   | config loading and validation, the git command parser, port probing, shared exec                                 |
| `guards`   | base   | the git and Claude Code hooks: trailers, worktree rules, provenance, the requirements lock                       |
| `plan`     | base   | `plan:check` (a staged pattern check: requirements → plan → build), `plan:status`, `claim`, the sources manifest |
| `ci`       | base   | `ci:local` and `land`                                                                                            |
| `setup`    | base   | `sdlc:init`, `bootstrap`, `accounts:check`                                                                       |
| `localdb`  | add it | a PGlite Postgres per worktree, snapshotted before every migrate or reset                                        |
| `seed`     | add it | deterministic demo data, opt-in per app                                                                          |
| `journeys` | add it | Playwright journeys with screenshots, diffs and learned masks. Recording runs three passes; testing runs one     |
| `coverage` | add it | merged coverage, per-package floors, the published report                                                        |
| `promote`  | add it | `promote:staging`, `promote:prod`, `rollback`, `release`: fast-forward only, green SHA required, smoke-tested    |
| `security` | add it | secrets (built-in, plus trufflehog or gitleaks), dependency audit, licences, install scripts, release age        |

`sdlc.config.json` is the one file a project edits to configure the tooling. CI
reads it from `origin/dev`, never from the branch under test.

## Everyday commands, in a project

```bash
pnpm plan:status                     # where the plan stands
pnpm claim <ID>                      # take an item before starting it
pnpm test && pnpm ci:local           # the gate, locally
pnpm land                            # verify, open and merge the pull request
pnpm sdlc diff base                  # what changed upstream, against what changed here
```

## Working on the registry

This repository is developed as a whole: every module and recipe is here, and
`pnpm test` runs the modules' suites, the CLI's and the registry pattern check.
`pnpm registry:check` (installs) runs `init`, `add`, `diff` and `update` end to
end; `pnpm recipes:check` (installs) builds every recipe through `add`. It is
not meant to be used as a GitHub template.

## Status

All eleven modules, sixteen skills, the recipes and the CLI are built. Not yet
exercised: `pnpm dlx github:sramam/ai-sdlc#<tag>` against GitHub itself (the
same path is proven from a local git URL), `ci:local`'s container mode, a live
OpenRouter call, and the authorization engines inside a deployed Worker.
