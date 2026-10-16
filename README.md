# ai-sdlc

A registry for software that AI agents and people build together, in the way
shadcn/ui is a registry. A project takes the development process (skills,
hooks, guards, local CI, the plan, the journey machinery, the docs) and the
reference code it needs as source files it then owns. The registry carries no
product code; a project decides its apps and packages during kickoff.

## Start a project

You need Node 24+, pnpm 10, git, the `gh` CLI and, for Cloudflare, `wrangler`.

```bash
pnpm dlx github:sramam/ai-sdlc#v0.2.0 init my-app   # base files, pnpm install, the first commit
cd my-app
gh auth login && wrangler login
gh repo create <owner>/my-app --private --source . --push
pnpm sdlc:init                                      # creates dev; settings and merge rules
claude plugin install claude-security@claude-plugins-official --scope project
```

Then tell your agent: _"Read `docs/kit/BOOTSTRAP.md` and follow it. Start with
`/kickoff`."_ Kickoff decides which modules, recipes and skills the project
needs, and the foundation items add them:

```bash
pnpm sdlc list                        # every item, and which are installed
pnpm sdlc add journeys coverage       # modules
pnpm sdlc add app-tanstack-workers    # a recipe, with what it requires
pnpm sdlc add stripe-best-practices   # a skill
```

## How a project moves

The workflow is Addy Osmani's
[agent-skills](https://github.com/addyosmani/agent-skills): spec, plan, build,
test, review, ship. This registry copies those skills in unchanged and adds
what its own projects need beside them, in wrapper skills.

```
/kickoff ─▶ approve the specs ─▶ /build auto ──────────────────────────────▶ /ship
 people,     a person, once:       plans, then for every ready item:          release, staging,
 product,    Approved: on each     claim ▶ worktree ▶ red · green · commit    journeys to QA,
 personas,   feature               ▶ review ▶ pnpm land                       production
 journeys,
 stack       later requests: /spec            every session starts with pnpm bootstrap
```

People type `/kickoff`, approve specs and decide technology. The pipeline does
the rest, and the git gates check that each step left its evidence.

- Requirements (`docs/requirements/`) change only through `/kickoff` and
  `/spec`. Every architecture choice and plan item traces back to one. You
  decide any new technology, through a pros-and-cons dialog.
- Personas and journeys are the units of value. A journey can span personas,
  with one journey per persona under it and the tasks each performs; the plan
  orders features so that each milestone completes whole journeys, and the
  `journeys` module records each one as evidence a person can review.
- The plan lives in the repo (`docs/plan/`), with stable IDs for personas,
  features, requirements, journeys and items. Git history gives each item's
  status. There are no GitHub Issues or Projects.
- Every agent session works in its own worktree, forked from `dev`, and claims
  its item first (`pnpm claim <ID>`), so two agents never build the same thing.
- Anything written for an agent to act on is held to five tenets: clarity,
  actionability, fidelity, efficiency and security
  ([principles.md](docs/kit/principles.md) § 0). The code review checks them.

## Architecture

`init` gives a project the base: the kit, the workflow's skills, the hooks and
guards, and the `core`, `guards`, `plan`, `ci` and `setup` modules. The project
adds everything else as an item when it needs it. An item is a module
(`journeys`, `localdb`, `seed`, `coverage`, `promote`, `security`), a skill
(`stripe-best-practices`, `scroll-craft`) or a recipe (reference
code for `packages/api`, `apps/web`, authorization, LLM access, UI and more).
`registry.json` lists them all.

A project owns everything it was given. Every item arrives as plain files, with
its tests, so an agent can read it, change it to fit, and fix it.
`sdlc.lock.json` records the hash of each file as copied, so
`pnpm sdlc diff <item>` can tell a local edit from an upstream change.
`pnpm sdlc update <item>` applies an upstream change only to a file still as it
was copied, and lists the rest, with the upstream diff, for an agent to fold in
by hand. [docs/kit/registry.md](docs/kit/registry.md) has the details.

Third-party skills follow a stricter rule, so that their authors' improvements
keep arriving. Each is copied verbatim into `.agents/3rdparty/<name>/` at a
recorded commit, and a test fails if anyone edits the copy. What agents load is
a wrapper in `.agents/skills/` with the upstream description, a link to the
copy, and this project's amendments. `pnpm 3rdparty sync <name>` takes a newer
upstream and lists the wrappers to re-read. Claude Code sees the skills through
symlinks in `.claude/skills/`.

A project has five layers. Each exists because the one above it drifts when
nothing enforces it.

| layer            | where                                                | what it does                                                                                                                                              |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The kit          | `docs/kit/`                                          | the specification and its reasons: principles, the SDLC, testing, security, UX, AI, environments, recipes. [Start here](docs/kit/README.md)               |
| Skills           | `.agents/skills/`                                    | the procedures agents follow: Addy Osmani's skills and commands with our amendments, `kickoff`, `journeys`, `progress-report`, and any skills added since |
| Fast enforcement | `.husky/`, `.claude/settings.json`, `tooling/guards` | caught in seconds: commit trailers, the requirements lock, worktree rules, refused pushes to `dev`/`staging`/`main`, denied merge and force-push commands |
| The merge gate   | `tooling/ci`, `tooling/plan`, `sdlc.config.json`     | `pnpm ci:local` runs every check in a clean snapshot and posts a `local-ci` commit status. `pnpm land` is the only way to merge. GitHub Actions stays off |
| Shared tooling   | `tooling/*`                                          | one workspace package per module (below), the project's to change                                                                                         |

`plan:check` refuses an item built from a spec nobody approved, and the trailer
check refuses a branch that changes source without a test unless a commit says
why. `pnpm land` refuses anything without a green `local-ci` status on its exact
commit.

Every check here has three answers: yes, no, and _could not ask_. The third is
never reported as a pass. A list that matters is counted by a test, a pattern
check. `registry.json` is one such list: every file here belongs to one item,
and the pattern check compares each item's imports and dependencies with what
it declares.

### Modules

| module     | item   | gives you                                                                                                                                       |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`     | base   | config loading and validation, the git command parser, port probing, shared exec, the skill links, `pnpm usage`                                 |
| `guards`   | base   | the git and Claude Code hooks: trailers, worktree rules, provenance, the requirements lock                                                      |
| `plan`     | base   | `plan:check` (a staged pattern check: requirements → plan → build), `plan:status`, `claim`, the sources manifest                                |
| `ci`       | base   | `ci:local` and `land`                                                                                                                           |
| `setup`    | base   | `sdlc:init`, `bootstrap` (also the session-start hook: the checks, the skill links, the security plugin, the newest handoffs), `accounts:check` |
| `localdb`  | add it | a PGlite Postgres per worktree, snapshotted before every migrate or reset                                                                       |
| `seed`     | add it | deterministic demo data, opt-in per app                                                                                                         |
| `journeys` | add it | Playwright journeys with screenshots, diffs and learned masks. Recording runs three passes; testing runs one                                    |
| `coverage` | add it | merged coverage, per-package floors, the published report                                                                                       |
| `promote`  | add it | `promote:staging`, `promote:prod`, `rollback`, `release`: fast-forward only, green SHA required, smoke-tested                                   |
| `security` | add it | secrets (built-in, plus trufflehog or gitleaks), dependency audit, licences, install scripts, release age, the threat-model review              |

`sdlc.config.json` is the one file a project edits to configure the tooling. CI
reads it from `origin/dev`, never from the branch under test.

## Everyday commands, in a project

```bash
pnpm bootstrap                       # is this checkout ready? (also runs at session start)
pnpm plan:status                     # where the plan stands
pnpm claim <ID>                      # take an item before starting it
pnpm test && pnpm ci:local           # the gate, locally
pnpm land                            # verify, open and merge the pull request
pnpm usage                           # AI cost across every worktree, from this machine's agent logs
pnpm sdlc diff base                  # what changed upstream, against what changed here
```

`pnpm usage` runs [codeburn](https://github.com/getagentseal/codeburn) at a
pinned version. Its figures are what the same tokens would cost on the API at
today's prices, read from this machine's logs only, and its commands that send
usage elsewhere are refused.

## Working on the registry

This repository is developed as a whole: every module, recipe and skill is
here, and `pnpm test` runs the modules' suites, the CLI's, the registry pattern
check and the third-party check. `pnpm registry:check` (installs) runs `init`,
`add`, `diff` and `update` end to end; `pnpm recipes:check` (installs) builds
every recipe through `add`. It is not a GitHub template.

## Status

The modules, the recipes, the CLI and the workflow's skills are built:
Addy Osmani's agent-skills at `aeac41d`, wrapped, plus three skills of our own
in base, `journeys` with its module, and two optional third-party skills. Not yet exercised:
`pnpm dlx github:sramam/ai-sdlc#<tag>` against GitHub itself (the same path is
proven from a local git URL), `ci:local`'s container mode, a live OpenRouter
call, and the authorization engines inside a deployed Worker.
