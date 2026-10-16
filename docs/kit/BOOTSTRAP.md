# Bootstrap — from an empty repo to a plan being worked

You are setting up a new project that several humans and several AI agents will
work in at the same time. **Precondition: the project was created with
`ai-sdlc init`** from the registry ([registry.md](registry.md)), which copies
base: this kit, its tooling, skills and hooks, and no product code. Everything
else arrives with `pnpm sdlc add <item>` when a foundation item needs it.

| phase                              | who                        | item                                     | output                                                                |
| ---------------------------------- | -------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| 0. create the project              | a person, then the agent   | none (no item can exist before the repo) | a GitHub repo from `ai-sdlc init`, `dev` as default, settings applied |
| 1. discovery                       | agent with the author      | `X-000`                                  | requirements, project brief, architecture, decisions                  |
| 2. configure and prove the tooling | agent (in parallel with 1) | `X-001`                                  | `sdlc.config.json`, `AGENTS.md`, every guard tripped                  |
| 3. plan                            | agent, from approved specs | `X-000` (its last PR)                    | `docs/plan/`: foundation items first, then features by journey        |
| 4. work the plan                   | agents                     | one item each                            | the product                                                           |

`X-000-discovery` and `X-001-configure` ship in base's `docs/plan/items/`,
because every project has them. So every commit after Phase 0 has an item to
name.

**Never sit idle waiting on the author.** When something needs their answer, ask,
write a `Q-` file, and carry on with whatever does not depend on it
([principles.md](principles.md) §15).

---

## Phase 0 — Create the project

**The person** (the CLIs need a browser login, once per machine):

```bash
pnpm dlx github:sramam/ai-sdlc#<tag> init <name>   # base, pnpm install, the first commit on main
cd <name>
gh auth login
wrangler login
gh repo create <owner>/<name> --private --source . --push
```

`init` refuses a directory that is not empty and touches nothing on GitHub. The
pre-push hook lets `main` into a repository with no branch at all, once; every
later update of `main` goes through `pnpm promote:prod`. The project's
`sdlc.lock.json` records the registry ref it came from, and `pnpm sdlc` runs the
CLI at that ref.

**The agent**, in that checkout:

```bash
pnpm sdlc:init
```

`sdlc:init` is idempotent, and prints a line per step:

- creates `dev` from `main` **through the GitHub API** (not a push, which
  `pre-push` refuses)
- sets `dev` as the default branch
- applies the repo settings with `gh api`: squash merge off, merge commits on,
  delete branches on merge, Issues, Projects and Actions off
- checks Git LFS is installed and the `.gitattributes` patterns are tracked
- runs `pnpm bootstrap` (one line per environment check)
- runs `pnpm ci:local` (steps that do not apply to an empty repo print `n/a`)

It reports, and does not hide, anything that **could not ask**.

From here on, **all work happens in worktrees** forked from `origin/dev`. The
main checkout is read-only to agents (`worktree-required`), apart from
`docs/handoffs/`.

## Phase 1 — Discovery (`X-000`)

Claim the item, then propose the worktree name (`x-000-discovery`; the user
may change it):

```bash
pnpm claim X-000                      # atomic: creates the branch x-000 on GitHub
git fetch origin x-000
git worktree add .claude/worktrees/x-000-discovery x-000 # worktree-base: claim branch
cd .claude/worktrees/x-000-discovery && pnpm install && pnpm bootstrap
# then EnterWorktree({ path: ".claude/worktrees/x-000-discovery" })
```

Discovery is `/kickoff`, one restartable skill in three stages that holds
the requirements lock throughout.

1. **Orientation.** It decides what does not depend on the product: people
   (including who approves specs), SDLC defaults, budget, the first accounts
   and working agreements. The topics that need the product (stack, delivery
   risks, apps and packages, architecture, technology, AI architecture) wait.
2. **The product.** It holds the conversation (or imports and vets existing
   documents) and writes the requirements: BRD, PRD, personas, access model,
   domain model, design brief, features, journeys (a journey may span personas,
   with one journey per persona under it), glossary and review. It **records**
   what needs deciding (technology triggers, the authorization-engine
   recommendation, the backoffice candidates) in `technology.md`, and does not
   decide them. Its verdict can be **ready, pending decisions**.
3. **Decisions.** It **decides** the waiting topics: the stack, every recorded
   technology trigger (through the dialog in
   [technology-decisions.md](technology-decisions.md); the user decides), the
   apps, packages and package scope, the backoffice split, the AI architecture,
   and it writes `docs/architecture.md`. Then the verdict is recomputed.

Phase 1 is done when the verdict is **ready to plan** or **ready with
assumptions**, the project brief's **Blocking** list is empty, and
`pnpm plan:check --stage requirements` passes. Land it with `pnpm land`: one
PR, or several as sections settle. Then **a person approves the first
features' specs** (an `Approved:` line on each; the one human gate).

## Phase 2 — Configure and prove the tooling (`X-001`)

It runs **in parallel with Phase 1**, in another session and worktree
(`x-001-configure`), in two parts. Base ships the tooling; this phase
**configures and proves** it, and builds nothing.

**Part 1, independent of discovery.** Land it when done.

- Set `claimStaleDays` in `sdlc.config.json`. **Leave `branches` as shipped**
  (`dev`, `staging`, `main`): the names are fixed, and the validator refuses
  any other value, because the pre-push hook, the permission denies and the
  skills name them literally. Coverage floors stay unset until there is code.
- Write the root `AGENTS.md` from `docs/kit/AGENTS.template.md`. Its packages
  section is filled in by the apps-and-packages foundation item.
- **Trip every guard** (the table below), and paste each refusal into the
  `X-001` PR.

**Part 2, after kickoff's first pass has landed** (merge `origin/dev` into the
branch first). Land it with `Closes: X-001`.

- Copy the accounts list and the reporting cadence from the project brief into
  `sdlc.config.json` (`accounts`, `cadence`), and run `pnpm accounts:check`.
- Add the modules kickoff's SDLC defaults call for, one commit each, and trip
  their guards the same way: `pnpm sdlc add security coverage` always (the CI
  steps `secrets`, `supply-chain` and `coverage` arrive with them), and
  `journeys`, `localdb`, `seed` and `promote` when the plan has journeys, a
  database, mock data and deployed environments. `pnpm install` after each.

The guards, and how to trip each:

| guard               | trip it by                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-push`          | `git push origin HEAD:dev`; `git push origin <a SHA on origin/dev>:refs/heads/staging` (only `pnpm promote:*` moves staging and main) |
| `commit-msg`        | a model-named trailer; `Progress:` naming no item; a `docs/requirements/` change with no `Requirements:` trailer                      |
| `requirements-lock` | an Edit under `docs/requirements/` with no lock; any Edit under `sources/`                                                            |
| `worktree-required` | an Edit in the main checkout (and check that `docs/handoffs/` is allowed)                                                             |
| `worktree-base`     | `git worktree add … main`                                                                                                             |
| `worktree-single`   | a second worktree in the same session                                                                                                 |
| `ci:local`          | a dirty tree; a branch without `origin/dev` as ancestor; no `Progress:`/`No-Item:`                                                    |
| `pnpm land`         | merging without a green `local-ci` status on the head SHA                                                                             |
| `plan:check`        | a duplicate ID; an item citing a missing requirement                                                                                  |

Guards that need product code (seed refusal, capture transports, `promote`,
the authorization pattern check) are tripped in the foundation items that create them.
The commit that lands this phase carries `Closes: X-001`.

## Phase 3 — Plan

`/plan` (or `/build auto`, which plans when nothing is planned) runs in the
`X-000` worktree once the first specs are approved. **Foundation first, as `X-`
items**, in this order, each with its own acceptance and trip tests:

| item                       | does                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| platform spike             | verifies each constraint in [tech-stack.md](tech-stack.md) § _Workers constraints to design for_ for the chosen stack: framework on Workers, ORM through Hyperdrive, auth library, OTel export, the authorization engine from a Worker and in tests, Base UI coverage. Findings become ADRs and package `agents.md` notes          |
| apps and packages          | adds each app and package from kickoff topic 9 with `pnpm sdlc add <recipe>` (`pnpm sdlc list`), one commit each, then adapts it to the decisions (scope, names) with its tests passing. Where no recipe exists, it writes the package directly and offers it to the registry as one. Fills in the packages section of `AGENTS.md` |
| infrastructure             | the agent writes `pnpm infra:provision`; **a person runs it** per environment; the agent writes `wrangler.jsonc` from its output; `/api/health` confirms                                                                                                                                                                           |
| environments and promotion | env and binding schema, `.dev.vars.example` pattern check, `pnpm sdlc add promote seed localdb`, a seed framework that refuses production                                                                                                                                                                                          |
| security baseline          | `@<scope>/authz` with the policy and a matrix-test generator (cells arrive with features), headers, CSP, rate limits, sessions                                                                                                                                                                                                     |
| telemetry                  | `@<scope>/telemetry`, span conventions, test exporter, lint against `console.log`                                                                                                                                                                                                                                                  |
| UI foundation              | tokens from the design brief, the shells, the patterns, ⌘K, the component viewer, the UI scan floor                                                                                                                                                                                                                                |
| test harness               | `createTestDb()`, the database-fake pattern check, the smoke test against the built Worker, `pnpm sdlc add journeys journeys-adapter`, journey ports, capture transports                                                                                                                                                           |

Then **features, ordered by journey**: each milestone completes whole journeys,
for every persona in them. Land it with `Closes: X-000`; `plan:check --stage
plan` must pass, and refuses an item from a feature whose spec has no
`Approved:` line. There is no separate plan approval: the spec was the gate.

## Phase 4 — Work the plan

Every session starts with `pnpm bootstrap` (a SessionStart hook runs it) and
picks up the handoffs it lists. Then `/build auto` works the plan: it claims the
next ready item (`pnpm claim`), creates its worktree from the claim branch,
builds it in slices with `Progress:` and `Closes:`, reviews it, lands it with
`pnpm land`, and moves to the next, until nothing is ready or something needs a
person. Long-running scripts run in the background
([multi-agent.md](multi-agent.md)). Every new ask goes through `/spec`. Reports
follow the cadence in `sdlc.config.json`, and the pickup says when one is due.

## Defaults kickoff confirms rather than asks

The SDLC defaults kickoff confirms are listed once, in
`.agents/skills/kickoff/SKILL.md` topic 4; the stack it confirms is topic 3 and
[tech-stack.md](tech-stack.md).

## Done means

- Phase 2's table is complete, with each refusal pasted into the `X-001` PR.
- A fresh clone of the project runs `pnpm install && pnpm bootstrap &&
pnpm ci:local` green, one line per check, and posts a `local-ci` status.
- `pnpm plan:check --stage plan` passes, and `pnpm plan:status` shows every item
  and every open question.
- A second agent can run `/build` and start work on the next ready item,
  asking nothing.
