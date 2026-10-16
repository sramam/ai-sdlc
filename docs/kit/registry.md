# The registry — `ai-sdlc`

`github.com/sramam/ai-sdlc` is a **registry**, in the way shadcn/ui is one: a
project takes what it needs, as source files it then owns. It is not a template
and nothing is inherited from it. These docs live in it at `docs/kit/`, and its
tooling is what they describe.

```bash
pnpm dlx github:sramam/ai-sdlc#<tag> init my-app   # base: the process, no product code
pnpm sdlc add journeys coverage                     # a module, inside the project
pnpm sdlc add app-tanstack-workers api              # a recipe, at its documented place
pnpm sdlc diff base                                 # what changed here, and upstream
pnpm sdlc update base                               # take upstream fixes; never overwrite an edit
```

## Why copies, not a dependency

Agents do most of the work in a project, so they should **own as much of the
code as possible**: read it, change it to fit, and fix it where it breaks. Code
in `node_modules`, or behind a "do not edit" rule, is code an agent works
around instead. So every item arrives as plain files in the project's tree, with
its tests, and is the project's from then on. `diff` and `update` bring upstream
fixes in deliberately, file by file; nothing arrives by itself.

## Base and items

| kind       | what                                                                                                                                                                                                                                                            | how it arrives                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **base**   | the kit (`docs/kit/`, with the recipes' index only), the workflow's skills (Addy Osmani's agent-skills and our wrappers), `.claude/settings.json`, `.husky/`, root configuration, the plan scaffold, and the `core`, `guards`, `plan`, `ci` and `setup` modules | `init`                                                                                 |
| **module** | `journeys`, `localdb`, `seed`, `coverage`, `promote`, `security`, each with its skills                                                                                                                                                                          | `pnpm sdlc add <module>`, into `tooling/<module>/`                                     |
| **skill**  | a third-party skill a project pulls in when its work calls for it: `humanizer`, `stripe-best-practices`, `scroll-craft` ([skills.md](skills.md))                                                                                                                | `pnpm sdlc add <skill>`, into `.agents/3rdparty/` and `.agents/skills/`                |
| **recipe** | reference code for the packages most projects need ([recipes/README.md](recipes/README.md))                                                                                                                                                                     | `pnpm sdlc add <recipe>`, at the place its README names: `packages/api`, `apps/web`, … |

`pnpm sdlc list` prints every item, what it requires and which are installed.
The foundation items (BOOTSTRAP Phase 3) name the items they add.

**Nothing in base would need deleting in some plausible project.** Anything a
project might not want is an item it adds or does not. Product code (entities,
capabilities, screens, policies) is in neither: it is written from what
`/kickoff` and `/spec` decided.

## `registry.json`

One file at the root lists every item: the files it copies (`from` → `to`, a
directory or a file; `except` leaves paths out), the items it `requires`, the
items it `conflicts` with, and what it merges into files the project shares:

| field                   | merged into                                                     | rule                                                                        |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `package`               | `package.json`, or `packageJson` (e.g. `apps/web/package.json`) | scripts and dependencies at exact versions; a key the project holds is kept |
| `config`                | `sdlc.config.json`                                              | a union: CI steps and databases matched by `name`; a project's value stands |
| `gitignore`             | `.gitignore`                                                    | missing lines added                                                         |
| `onlyBuiltDependencies` | `pnpm-workspace.yaml`                                           | missing names added                                                         |

A merge never removes or overwrites; where the project has its own value, it
stays and `add` says so. The `seed` files (`package.json`, `sdlc.config.json`,
`.gitignore`, `pnpm-workspace.yaml`, partly from `template/`) are written once by
`init` and are the project's from the first byte; later changes reach them only
through items' merges.

One root file rather than a manifest beside each item, because an item is not a
directory: base gathers root configuration, ten skills, the kit and five
modules from all over the tree. In one file, "every file belongs to exactly one
item" is a single pass, and nothing that exists only for the registry is copied.

**The registry's pattern check** (`scripts/registry/pattern-check.test.ts`, in
`pnpm test`; `pnpm registry:patterns` prints its table) holds `registry.json` to
the tree:

- every file belongs to exactly one item, or is in `exclude` with a reason, and
  no exclusion is stale
- an item's relative imports resolve, **in the project's layout**, to its own
  files, base's, or an item it requires; a requirement no import shows says why
  (`requiresBecause`); there is no cycle; two items install one path only if
  each names the other in `conflicts`
- every package an item's code imports is declared by a `package.json` above it
  in the project, and one `package.json` never gets two versions of a name
- base's and the modules' scripts and pins are this repository's own (its
  `package.json`, its lockfile's resolution), and its `sdlc.config.json` is
  `template/sdlc.config.json` plus their config fragments

**Recipes are written for where they land.** A recipe imports its siblings at
their installed paths (`api-bindings` imports `../../api/src/…`, which is
`packages/api` beside `packages/bindings`), so nothing is rewritten on copy and
a copied file's hash is the registry's. `pnpm recipes:check` installs each
recipe into a scratch project through `init` and `add`, then installs,
typechecks and runs its tests, answering _pass_, _fail_, _could not run_ (a step
exited 2, such as an authorization engine that was not started) or _not
checked_, with the reason from its `check` in `registry.json`. It needs the
network and is run by hand when a recipe changes.

## The CLI, and how it is run

`scripts/registry/cli.mjs` is plain JavaScript with JSDoc types and no
dependencies. It has to be: `pnpm dlx github:…` installs the package into
`node_modules`, and Node 24 refuses to strip TypeScript types there
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The `.mts` it copies into a
project runs from the project's own tree, where that does not apply.

| form                                              | when                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm dlx github:sramam/ai-sdlc#<tag> init <dir>` | a new project. Without `--ref`, the source is the tag of the CLI's own version                                   |
| `pnpm sdlc <command>`                             | inside a project: `init` writes the script, pinned to the source's ref, and `update --ref` moves it              |
| `--from <dir>`                                    | a local checkout of the registry, for tests and offline use; the project's `sdlc` script then runs the CLI there |

The registry's own `package.json` has no `prepare` script, because pnpm refuses
a git-fetched package that has one (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`). Its
hooks install from `postinstall`, which a `dlx` install merely skips (and says
so in a box).

**`init` creates a project; it does not touch GitHub.** It copies base, writes
`package.json` (named after the directory), `sdlc.config.json` and the lock,
then runs `git init`, `pnpm install` (unless `--no-install`; it installs the
hooks) and makes the first commit through those hooks (unless `--no-commit`). It
refuses a directory that is not empty. A person then creates the repository and
pushes `main` (`gh repo create <owner>/<name> --private --source . --push`; the
pre-push hook allows `main` into a repository with no branch at all, and
nothing after that) and runs `pnpm sdlc:init`, which creates `dev`, applies the
settings and the ruleset, and runs `bootstrap` and `ci:local`.

**`add <item…>`** copies the items and what they require, then applies their
merges. It refuses, writing nothing, when a target exists with other content (an
identical one is fine), when an item conflicts with one installed or being
added, or when a `package` fragment's `package.json` is not there. Adding an
installed item changes nothing and points at `diff`.

## The lock, `diff` and `update`

`sdlc.lock.json` records the source (repository, ref and commit, or a local path
and whether its tree was dirty) and, per item, the ref and commit it came from,
each copied file's source path and SHA-256, and the merges it applied. The hash
at copy time is the merge base, which is what tells _changed here_ from _changed
upstream_:

| here vs copied | upstream vs copied | state                                           | `update`                                           |
| -------------- | ------------------ | ----------------------------------------------- | -------------------------------------------------- |
| same           | same               | unchanged                                       | nothing                                            |
| same           | different          | changed upstream                                | applies it                                         |
| different      | same               | locally modified                                | keeps it                                           |
| different      | different          | both changed (`diff` shows the upstream change) | **lists it**; nothing is overwritten               |
| absent         | new upstream       | added upstream                                  | copies it, or lists a different file already there |
| same           | gone upstream      | removed upstream                                | deletes it                                         |
| different      | gone upstream      | removed upstream, modified here                 | keeps it                                           |

For a file changed on both sides, `diff` prints the upstream change as a unified
diff from the copied version (read from the source's history at the locked
commit) to upstream, so an agent can apply the same change to its own copy.
After folding it in, `pnpm sdlc update <item> --accept <file>` records the file
as merged. Merges follow the same rule: a script or version that changed
upstream is updated only where the project still holds the value the item set;
anything else is reported.

`--ref <tag|branch|commit>` picks the upstream; without it, `diff` and `update`
fetch the lock's ref again (a branch moves; a tag does not). Fetches are shallow
and cached by commit under `$XDG_CACHE_HOME/ai-sdlc` (default `~/.cache/ai-sdlc`).
A source that cannot be reached is _could not ask_ (exit 2), never "nothing to
update".

**A config format change** raises `configVersion` in `sdlc.config.json`; the
item's `notes`, which `add` and `update` print, say how to convert.

## Third-party skills

Some items carry skills other people maintain: Addy Osmani's agent-skills in
base, and the `skill` items. They follow one rule: **copied verbatim, amended
beside.** The copy lives in `.agents/3rdparty/<name>/`, laid out as upstream
lays it out so its relative links resolve, with a `SOURCE.json` naming the
repository, ref, commit, license, the paths taken and each file's SHA-256.
What agents load is our wrapper in `.agents/skills/<name>/SKILL.md`: upstream's
description, a link to the copy, and this project's amendments.

In the registry, `pnpm 3rdparty sync <name> [--ref <ref>]` clones upstream into
a temporary directory, prints the upstream log and diff since the recorded
commit, replaces the copy, and lists the wrappers whose upstream changed, to
re-read against their amendments. `third-party.test.ts` fails on an edited copy,
an unwrapped entry, a wrapper whose description drifted, or a skill Claude Code
cannot see. A project takes the result with `pnpm sdlc update`: since nobody
edits a copy, every change to one applies cleanly.

A skill whose license forbids redistribution is referenced, not copied:
claude-security is declared in `.claude/settings.json` (`enabledPlugins`) and
each person installs it; `pnpm bootstrap` says when they have not.

**Moving a project from `.claude/skills/` to `.agents/skills/`** (projects
created before October 2026): `pnpm sdlc update base` copies the new skills and
links them, and removes the old skill files. Commit it in two steps, because
git cannot stage a path beyond a symlink in the commit that deletes the file
there: first remove the links (`find .claude/skills -maxdepth 1 -type l
-delete`) and commit everything else, then `pnpm bootstrap` (which recreates
them) and commit the links.

## Layout of a new project

```
.claude/settings.json      permissions (deny list: a courtesy, not a boundary), attribution, hooks
.agents/3rdparty/          third-party skills, verbatim at a recorded commit (agent-skills; added skills)
.agents/skills/            the skills agents load: a wrapper per upstream skill and command, plus
                           kickoff and progress-report (modules add journeys and procedures)
.claude/skills/            symlinks to .agents/skills/<name>, so Claude Code sees them
.claude/agents/            the personas /ship fans out to, wrapping upstream's
.husky/                    pre-commit · prepare-commit-msg · commit-msg · pre-push
.gitattributes             Git LFS patterns for journey screenshots, masks and rendered emails
.gitignore                 .env*, .dev.vars (not *.example), worktrees, handoffs, one-of scripts, .ci-local/
tooling/                   core · guards · plan · ci · setup; modules arrive beside them. One
                           workspace package each, importing each other by relative path,
                           because hooks run with plain node before pnpm install
scripts/one-of/            GITIGNORED: throwaway scripts
apps/  packages/           EMPTY; kickoff decides them; recipes and the project fill them
docs/kit/                  this kit (a recipe's README arrives with the recipe)
docs/requirements/         LOCKED: written only by /kickoff and /spec
docs/plan/items/           X-000-discovery.md, X-001-configure.md
docs/adr/                  ADR-000-starter-tooling.md
docs/progress/  docs/handoffs/
sdlc.config.json           the tooling's configuration: declarative JSON, validated, never executed
sdlc.lock.json             what was taken from the registry, and the hashes diff and update compare
```

**The config is data, and CI reads it from the trusted base.** `sdlc.config.json`
is strict JSON, validated against one shape in `tooling/core` (an unknown key or
a wrong type is an error naming its path). `ci:local` reads its steps from
`origin/<integration>`, never from the commit under test, so a branch cannot
rewrite its own gate.

**`ci:local` on an empty repo.** Each step declares when it applies (_build_
needs an app; _coverage_ needs source files). A step that does not apply prints
`n/a (<reason>)`, which is distinct from _could not run_ and does not hold the
verdict.

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

## Lessons flow back

A project that fixes something in an item fixes it in place, then offers the
change to the registry (`/progress-report` asks; [memory.md](memory.md)). Other
projects take it with `diff` and `update` when they choose to.

## Building the registry from door_nexa

door_nexa holds about 14,000 lines of scripts and 16,600 lines of e2e support.
Extracting the kit meant **generalising and leaving behind**, not copying:

| take, and generalise                                                                                                                 | leave behind (door_nexa's product)                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| worktree guards, `git-command`, the registry, `worktrees`                                                                            | `clickup/*`, the ClickUp sync, weekly plan, status, and everything about the board                    |
| `ci-local` (steps become config), the coverage gate                                                                                  | Neon branch scripts (replaced by per-environment Hyperdrive and DB config)                            |
| `journey-*` (record, masks, delta, drift, index, verdict, status, regions)                                                           | jurisdiction, screening, address, payouts and statements scripts                                      |
| `e2e/support`: journey, mask, page-diff, dom-boxes, ports, stack, verdict, pdf-pages, the pattern checks                             | `e2e/support`: portfolio, onboarding, staff, organization, and every per-journey helper               |
| `bootstrap`, `load-env` (main-checkout fallback), the attribution trailer, lockfile checks; `issue-check` reworked into `item-check` | `dev-session` as written (Better Auth and organization specific; it becomes the `dev-session` recipe) |
| `playground-db` (per-checkout data directory, port probing, pid lock)                                                                | seed portfolio, seed history, fixtures                                                                |
| the skills, generalised                                                                                                              | persona agents, and the journey and persona registries                                                |

Each extracted piece must pass its own tests in a new project, and every pattern
check must pass **vacuously** on an empty project and **meaningfully** after one
capability and one journey are added. Prove both by tripping them.
