# The starter repo — `ai-sdlc`

This repository **is** the starter. These docs live in it at `docs/kit/`, and its
tooling is what they describe.

A new project **is created from the starter** as a GitHub template
(`gh repo create --template`). The starter holds everything that is
the same for every project: the SDLC tooling, the journey machinery, the
harness, the hooks and the kit docs. It holds **no product code**. Nothing in it
assumes a domain, a persona, an entity or a vendor choice beyond the settled
stack, so a project never starts by deleting things. Product code is generated
by the setup agent from what `/kickoff` and `/idea` decided.

## The rule that keeps it deletion-free

| in the starter                                                                                                                   | not in the starter                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| tooling that runs **against** a product: CI, plan, journeys, guards, promotion                                                   | code that **is** the product: entities, capabilities, screens, policies                                |
| **recipes**: reference implementations most projects need (listed under _Layout_), kept as docs and **not wired into the build** | **any app, and any package.** Which apps exist, and which packages, is decided in `/kickoff` (topic 9) |
|                                                                                                                                  | a feature, a persona, a tenancy model                                                                  |
| configuration with neutral defaults (`sdlc.config.json`)                                                                         | a vendor wrapper for a vendor not yet chosen (Oso _and_ SpiceDB, Resend _and_ Postmark)                |
| censuses that pass vacuously on an empty project                                                                                 | fixtures, seeds or journeys about anything                                                             |

If a starter file would need deleting for some plausible project, it does not
belong in the starter. It belongs in the docs, as a recipe the setup agent
follows when that project needs it.

**Recipes are how code is reused without being imposed.** `docs/kit/recipes/`
holds tested reference code for the packages most projects end up with. When
kickoff decides a project needs a package, the setup agent instantiates its
recipe into `packages/<name>`, adapted to the decisions, and the project owns it
from then on. Nothing is built from `recipes/`, so a project that needs none of
them deletes nothing. Once recipes exist, the starter's own test suite builds every recipe into a
scratch workspace and runs its tests, so recipes stay correct.

## Layout

```
.claude/
  settings.json            permissions (deny list: a courtesy, not a boundary), attribution, hooks
  skills/                  kickoff · idea · add-requirement · plan · land · handoff · pickup
                           progress-report · commit-reviewer · code-reviewer
                           (journey-*, release and coverage-report arrive with their tooling)
  requirements-session     GITIGNORED: the requirements lock holder for this checkout
.husky/                    pre-commit · prepare-commit-msg · commit-msg · pre-push
.gitattributes             Git LFS patterns for journey screenshots, masks and rendered emails
.gitignore                 .env*, .dev.vars (not *.example), .claude/worktrees/, .claude/requirements-session,
                           docs/handoffs/, scripts/one-of/, .ci-local/
tooling/                   THE SDLC TOOLING: one workspace package per module, UPSTREAM-OWNED.
                           A project replaces a module by listing it in sdlc.config.json
                           modules.replaced (see "Modules")
  core/                    @ai-sdlc/core: config loader (modules, upstream paths), exec,
                           the single git-command parser
  guards/                  @ai-sdlc/guards: worktree-required · worktree-base · worktree-single
                           · worktree-trace · worktrees · requirements-lock · provenance
                           (prepare-commit-msg) · trailers (commit-msg, and --range for ci:local)
  plan/                    @ai-sdlc/plan: plan-lib (the markdown conventions) · plan-check
                           (staged census) · plan-status (from git) · item-check
  ci/                      @ai-sdlc/ci: ci-local (snapshot in .ci-local/run-<sha>-<random>/, scrubbed env,
                           local-ci commit status, fingerprint reuse)
  setup/                   @ai-sdlc/setup: sdlc-init · sdlc-update · bootstrap · accounts-check
                           · load-env
  journeys/                @ai-sdlc/journeys (to come): three-pass recording, one-pass testing,
                           masks, delta, drift, index, verdict, plus its skills
                           (later modules: coverage, promote, playground, infra helpers)
scripts/                   the PROJECT's own durable scripts: committed, linted, tested
  one-of/                  GITIGNORED: throwaway scripts, never committed
e2e/                       the project's journey specs and fixtures, when it has journeys
apps/                      EMPTY; kickoff decides the apps
packages/                  EMPTY; kickoff decides the packages, instantiated from recipes
docs/
  kit/                     the kit's docs (this directory), upstream-owned
    recipes/               reference packages: api (port skeleton), db (client,
                           createTestDb, retention map), ui (shadcn on Base UI,
                           shell, patterns), telemetry, authz-oso, authz-spicedb,
                           llm-openrouter, env-schema, app-tanstack-workers,
                           dev-session (signs in a seeded account for scripts)
  requirements/            LOCKED: written only by /kickoff, /idea, /add-requirement
    sources/               imported documents, never edited
  guardrails.md            the non-negotiables: the starter's, then the project's own
  plan/items/              X-000-discovery.md, X-001-configure.md (every project has them)
  adr/                     ADR-000-starter-tooling.md (accounts for the starter's dependencies)
  progress/                empty, with a README saying what goes there
sdlc.config.json           the project's knobs: branches, ID prefixes, ci steps,
                           coverage floors, journey paths, environments. Declarative
                           JSON, validated and never executed (tooling/core/README.md)
starter-manifest.json      what the starter owns here, and how sdlc:update updates each path
.sdlc-version              the starter release this project last took (written by sdlc:update)
```

Because the starter has no apps, `wrangler.jsonc` and the e2e configuration are
written by the foundation items once kickoff has named the apps.

**The config is data, and CI reads it from the trusted base.** `sdlc.config.json`
is strict JSON, validated against one shape in `tooling/core` (an unknown key or
a wrong type is an error naming its path). `ci:local` reads its steps from
`origin/<integration>`, never from the commit under test, so a branch cannot
rewrite its own gate: a branch that changes the config is warned that the change
takes effect only after it lands.

**`ci:local` on an empty repo.** Each step in `sdlc.config.json` declares when it
applies (for example _build_ needs an app; _coverage_ needs source files). A
step that does not apply prints `n/a (<reason>)`, which is distinct from
_could not run_ and does not hold the verdict.

## Modules

Each module is a workspace package under `tooling/` with its own README,
`agents.md` and tests, so it can be understood, upgraded or replaced on its
own:

| module     | depends on | a project might replace it to                                   |
| ---------- | ---------- | --------------------------------------------------------------- |
| `core`     | nothing    | (rarely)                                                        |
| `guards`   | core, plan | add a guard, or drop the worktree discipline for a solo project |
| `plan`     | core       | read a different requirements format                            |
| `ci`       | core, plan | run CI in hosted Actions instead                                |
| `setup`    | core       | target a host other than GitHub                                 |
| `journeys` | core       | use another e2e approach                                        |
| `localdb`  | core       | use a containerised Postgres, or another engine                 |
| `seed`     | core       | use the ORM's own seeding                                       |

- **Packages import each other by relative path**, never through
  `node_modules`, because hooks run with plain `node` before `pnpm install`.
- **To replace a module**: write the replacement (in place, or as another
  package), and add the module's name to `modules.replaced` in
  `sdlc.config.json`. From then on `sdlc:update` skips it and the commit hook
  stops warning about it. Removing a module entirely also means removing its
  hooks from `.claude/settings.json` and `.husky/`, and its steps from
  `ci.steps`.
- **The upstream-owned paths are computed once**, in `core`
  (`upstreamPaths()`): the `replace` entries of `starter-manifest.json`, less
  replaced modules (or, with no manifest, the module list and the starter's
  skills). Nothing keeps a second copy.

## `scripts/` and `scripts/one-of/`

|               | `scripts/`                                           | `scripts/one-of/`                                        |
| ------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| for           | anything run twice, or by anyone else                | a throwaway: a probe, a one-time data fix, an experiment |
| committed     | yes                                                  | **no**, gitignored                                       |
| quality       | linted, typechecked, tested; prints a line per check | none required                                            |
| named in docs | yes, via `pnpm <name>`                               | never                                                    |

**Promote a one-of the second time you need it.** Move it to `scripts/`, give it
a name, a test and a `package.json` entry. A one-of that two people run is a
script with no review.

## Updating from upstream

Clones diverge, so improvements to the starter need a path back in.

- **`starter-manifest.json` says what the starter owns**, and how each path is
  updated:

  | kind          | paths                                                                                   | an update                                                                                |
  | ------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
  | `replace`     | `tooling/<module>/`, `docs/kit/`, the starter's skills, `.husky/*`, the manifest itself | takes the starter's version outright                                                     |
  | `merge-json`  | `.claude/settings.json`                                                                 | unions hooks and permission lists by value; a project's addition is never removed        |
  | `merge-json`  | root `package.json`, limited to the `keys` the manifest lists                           | sets the starter's own `scripts` and `devDependencies`; every other key is the project's |
  | `merge-lines` | `.gitignore`, `.gitattributes`, `pnpm-workspace.yaml`                                   | adds missing lines beside their neighbours; never removes one                            |

- **Upstream-owned paths are never edited in a project**: the `replace`
  entries, less any module in `modules.replaced`. A project changes behaviour
  through `sdlc.config.json`, or by adding its own files beside them. The
  commit hook warns when an upstream-owned path is edited.
- **Pull updates** with `pnpm sdlc:update` (`--dry-run` prints the plan per
  path: replace, merge, skip, unchanged). It uses the `starter` remote that
  Phase 0 adds, reads the manifest from `starter/main`, refuses a dirty tree (a dry run looks anyway),
  applies each entry, writes the release to `.sdlc-version`, and prints every
  section of `docs/kit/MIGRATIONS.md` newer than the project's version. It
  never stages or commits; the diff is for review.
- **A config format change is a migration.** A starter that needs a newer
  `configVersion` than the project's declares `minConfigVersion`, and
  `sdlc:update` refuses until the project has converted its config, printing
  the section that says how.
- A project that needs to change upstream behaviour sends the change **to the
  starter**, so every project gets it.

## Building the starter from door_nexa

door_nexa holds about 14,000 lines of scripts and 16,600 lines of e2e support.
Extracting the starter means **generalising and leaving behind**, not copying:

| take, and generalise                                                                                                                 | leave behind (door_nexa's product)                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| worktree guards, `git-command`, the registry, `worktrees`                                                                            | `clickup/*`, the ClickUp sync, weekly plan, status, and everything about the board                    |
| `ci-local` (steps become config), the coverage gate                                                                                  | Neon branch scripts (replaced by per-environment Hyperdrive and DB config)                            |
| `journey-*` (record, masks, delta, drift, index, verdict, status, regions)                                                           | jurisdiction, screening, address, payouts and statements scripts                                      |
| `e2e/support`: journey, mask, page-diff, dom-boxes, ports, stack, verdict, pdf-pages, the censuses                                   | `e2e/support`: portfolio, onboarding, staff, organization, and every per-journey helper               |
| `bootstrap`, `load-env` (main-checkout fallback), the attribution trailer, lockfile checks; `issue-check` reworked into `item-check` | `dev-session` as written (Better Auth and organization specific; it becomes the `dev-session` recipe) |
| `playground-db` (per-checkout data directory, port probing, pid lock)                                                                | seed portfolio, seed history, fixtures                                                                |
| the skills, generalised                                                                                                              | persona agents, and the journey and persona registries                                                |

Each extracted piece must pass its own tests in the empty starter, and every
census must pass **vacuously** on an empty project and **meaningfully** after
one capability and one journey are added. Prove both by tripping them.
