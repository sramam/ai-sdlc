# Bootstrap — from an empty repo to a plan being worked

You are setting up a new project that several humans and several AI agents will
work in at the same time. **Precondition: the starter repo exists**, built per
[starter-repo.md](starter-repo.md). If it does not, build the starter first; this
document assumes its tooling.

| phase                              | who                           | item                                     | output                                                             |
| ---------------------------------- | ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| 0. create the project              | a person, then the agent      | none (no item can exist before the repo) | a GitHub repo from the starter, `dev` as default, settings applied |
| 1. discovery                       | agent with the author         | `X-000`                                  | requirements, project brief, architecture, decisions               |
| 2. configure and prove the tooling | agent (in parallel with 1)    | `X-001`                                  | `sdlc.config.json`, `AGENTS.md`, every guard tripped               |
| 3. plan                            | agent, approved by the author | `X-000` (its last PR)                    | `docs/plan/`: foundation items first, then features by journey     |
| 4. work the plan                   | agents                        | one item each                            | the product                                                        |

`X-000-discovery` and `X-001-configure` ship in the starter's `docs/plan/items/`,
because every project has them. So every commit after Phase 0 has an item to
name.

**Never sit idle waiting on the author.** When something needs their answer, ask,
write a `Q-` file, and carry on with whatever does not depend on it
([principles.md](principles.md) §15).

---

## Phase 0 — Create the project

**The person** (the CLIs need a browser login, once per machine):

```bash
gh auth login
wrangler login
gh repo create sramam/<name> --template sramam/ai-sdlc --private --clone
cd <name>
git remote add starter https://github.com/sramam/ai-sdlc.git   # for pnpm sdlc:update
```

A template copy has clean history and its own `origin`, so there is nothing to
rename.

**The agent**, in that checkout:

```bash
pnpm install
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

Discovery runs in three steps, each skill restartable. **No skill calls another**,
so the requirements lock always has one holder.

1. **`/kickoff`, first pass.** It decides what does not depend on the product:
   people, SDLC defaults, budget, the first accounts and working agreements. The
   topics that need the product (stack, delivery risks, apps and packages,
   architecture, technology, AI architecture) are marked _waiting on /idea_.
2. **`/idea`.** It holds the conversation (or imports and vets existing
   documents) and writes the requirements: BRD, PRD, personas, access model,
   domain model, design brief, features, journeys, glossary and review. It
   **records** what needs deciding (technology triggers, the authorization-engine
   recommendation, the backoffice candidates) in `technology.md`, and does not
   decide them. Its verdict can be **ready, pending decisions**.
3. **`/kickoff`, second pass.** It **decides** the waiting topics: the stack,
   every recorded technology trigger (through the dialog in
   [technology-decisions.md](technology-decisions.md); the user decides), the
   apps, packages and package scope, the backoffice split, the AI architecture,
   and it writes `docs/architecture.md`. Then `/idea status` recomputes the
   verdict.

Phase 1 is done when the verdict is **ready to plan** or **ready with
assumptions**, the project brief's **Blocking** list is empty, and
`pnpm plan:check --stage requirements` passes. Land it with `/land`: one PR, or
several as sections settle.

## Phase 2 — Configure and prove the tooling (`X-001`)

It runs **in parallel with Phase 1**, in another session and worktree
(`x-001-configure`), in two parts. The starter ships the tooling; this phase
**configures and proves** it, and builds nothing.

- **Part 1, independent of discovery:** trip every guard (the table below),
  set `claimStaleDays`. Land it.
- **Part 2, after kickoff's first pass has landed** (merge `origin/dev` into
  the branch first): copy the accounts list and the reporting cadence from the
  project brief into `sdlc.config.json`, and run `pnpm accounts:check`. Land it
  with `Closes: X-001`.

- Fill in `sdlc.config.json`: ID prefixes and `claimStaleDays`. **Leave
  `branches` as shipped** (`dev`, `staging`, `main`): the names are fixed, and
  the validator refuses any other value, because the pre-push hook, the
  permission denies and the skills name them literally. The
  accounts list and the reporting cadence come from the project brief once
  kickoff's first pass has decided them; coverage floors stay unset until there
  is code.
- Write the root `AGENTS.md` from `docs/kit/AGENTS.template.md`. Its packages
  section is filled in by the apps-and-packages foundation item.
- Run `pnpm accounts:check`.
- **Trip every guard**, and paste each refusal into the `X-001` PR:

| guard               | trip it by                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-push`          | `git push origin HEAD:dev`; `git push origin <a SHA on origin/dev>:refs/heads/staging` (only `pnpm promote:*` moves staging and main) |
| `commit-msg`        | a model-named trailer; `Progress:` naming no item; a `docs/requirements/` change with no `Requirements:` trailer                      |
| `requirements-lock` | an Edit under `docs/requirements/` with no lock; any Edit under `sources/`                                                            |
| `worktree-required` | an Edit in the main checkout (and check that `docs/handoffs/` is allowed)                                                             |
| `worktree-base`     | `git worktree add … main`                                                                                                             |
| `worktree-single`   | a second worktree in the same session                                                                                                 |
| `ci:local`          | a dirty tree; a branch without `origin/dev` as ancestor; no `Progress:`/`No-Item:`                                                    |
| `/land`             | merging without a green `local-ci` status on the head SHA                                                                             |
| `plan:check`        | a duplicate ID; an item citing a missing requirement                                                                                  |

Guards that need product code (seed refusal, capture transports, `promote`,
the authorization census) are tripped in the foundation items that create them.
The commit that lands this phase carries `Closes: X-001`.

## Phase 3 — Plan

Run **`/plan`** in the `X-000` worktree as discovery's last step. **Foundation
first, as `X-` items**, in this order, each with its own acceptance and trip tests:

| item                       | does                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| platform spike             | verifies everything marked _verify_ in the kit for the chosen stack: framework on Workers, ORM through Hyperdrive, auth library, OTel export, the authorization engine from a Worker and in tests, Base UI coverage. Findings become ADRs and package `agents.md` notes |
| apps and packages          | instantiates each app and package from kickoff topic 9 from `docs/kit/recipes/`, one commit each, with its tests passing. Where no recipe exists yet, it writes the package directly and offers it upstream as a recipe. Fills in the packages section of `AGENTS.md`   |
| infrastructure             | the agent writes `pnpm infra:provision`; **a person runs it** per environment; the agent writes `wrangler.jsonc` from its output; `/api/health` confirms                                                                                                                |
| environments and promotion | env and binding schema, `.dev.vars.example` census, promote scripts, a seed framework that refuses production                                                                                                                                                           |
| security baseline          | `@<scope>/authz` with the policy and a matrix-test generator (cells arrive with features), headers, CSP, rate limits, sessions                                                                                                                                          |
| telemetry                  | `@<scope>/telemetry`, span conventions, test exporter, lint against `console.log`                                                                                                                                                                                       |
| UI foundation              | tokens from the design brief, the shells, the patterns, ⌘K, the component viewer, the UI scan floor                                                                                                                                                                     |
| test harness               | `createTestDb()`, the database-fake census, the smoke test against the built Worker, journey ports, capture transports                                                                                                                                                  |

Then **features, ordered by journey**. Show the plan to the author before code
starts, and land it with `Closes: X-000`. `plan:check --stage plan` must pass.

## Phase 4 — Work the plan

Every session runs `/pickup`, then `/plan next`. That claims the next ready
item, proposes a worktree name (the item ID; the user may change the slug),
creates the worktree and branch, and pushes the claim. Long-running scripts run
in the background ([multi-agent.md](multi-agent.md)). Build, commit with `Progress:` and `Closes:`,
then `/land`. Every new ask goes through `/add-requirement`. Reports follow the
cadence in `sdlc.config.json`, and `/pickup` says when one is due.

## Defaults kickoff confirms rather than asks

|                       | default                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| backlog               | the plan in the repo (`docs/plan/`), status derived from git. No GitHub Issues or Projects                                            |
| CI                    | local (`pnpm ci:local`). GitHub Actions off unless the author opts in                                                                 |
| branches              | lowercase `<item-id>-<slug>` → PR → `dev` → ff → `staging` → ff → `main`                                                              |
| merges                | merge commits; squash disabled                                                                                                        |
| framework and hosting | TanStack Start on Cloudflare Workers; R2, Queues, Cron Triggers, Workflows; Hyperdrive when Postgres ([tech-stack.md](tech-stack.md)) |
| environments          | local (per checkout), plus dev, staging and production ([environments.md](environments.md))                                           |
| auth                  | passwordless OTP or passkeys; MFA for privileged roles                                                                                |
| authorization         | Oso or SpiceDB, recommended by `/idea`, decided by `/kickoff` ([security.md](security.md))                                            |
| observability         | OpenTelemetry from the first commit ([observability.md](observability.md))                                                            |
| security              | highest threat model; ASVS L3 for auth, authorization, money and personal data                                                        |
| models and GPUs       | OpenRouter with zero-data-retention routing for real data; vast.ai for non-sensitive work only                                        |
| UI                    | shadcn/ui on Base UI; a shell per persona group; role switching; a separated backoffice ([ux.md](ux.md))                              |
| AI                    | asked of every application: act, propose, assist, see, notice, set up ([ai.md](ai.md))                                                |
| integrations          | vendor CLIs first; `pnpm accounts:check`                                                                                              |
| journeys              | three-pass recording with learned data-volatile masks; one-pass testing; Git LFS ([testing.md](testing.md))                           |

## Done means

- Phase 2's table is complete, with each refusal pasted into the `X-001` PR.
- A fresh clone of the project runs `pnpm install && pnpm bootstrap &&
pnpm ci:local` green, one line per check, and posts a `local-ci` status.
- `pnpm plan:check --stage plan` passes, and `pnpm plan:status` shows every item
  and every open question.
- A second agent can run `/plan next` and start work, asking nothing but to
  confirm its worktree name.
