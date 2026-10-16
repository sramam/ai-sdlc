<!--
Starting point for the new repository's root AGENTS.md. CLAUDE.md should contain
only `@AGENTS.md`.

Rules for this file itself:
- It is loaded into every session, so it is the most expensive text in the repo.
  Keep it under ~200 lines.
- Rules, not stories. The incident that produced a rule goes in the PR or ADR that
  added it, with a one-line pointer here at most.
- No numbers that describe "now". Name the command that answers them.
- If a rule is enforced by a hook or gate, say which, in one line.
Delete this comment once filled in.
-->

# <Project name>

Imported into every session (keep these short; an `@` costs context on every turn):

- Guardrails: @docs/guardrails.md
- Architecture: @docs/architecture.md
- Personas: @docs/requirements/personas.md

Read when relevant (referenced, not imported):

- The kit: `docs/kit/` (`sdlc.md`, `principles.md`, `security.md`,
  `observability.md`, `ux.md`, `ai.md`, `memory.md`, `hooks.md` for the trailer grammar,
  `plan-and-requirements.md`)
- Project brief: `docs/requirements/project-brief.md`
- Access model: `docs/requirements/access-model.md` (tenancy, roles, row scope) · BRD/PRD: `docs/requirements/`
- Features: `docs/requirements/features/` (load only the one you are working on)
- Plan: `docs/plan/` (status comes from `pnpm plan:status`, never from a file)
- Repo: <link>

Packages (each has its own `agents.md`):

- `@<scope>/<app>`: @apps/<app>/agents.md (apps as decided in kickoff topic 9)
- one line per package decided in kickoff topic 9, for example
  `@<scope>/db`: @packages/db/agents.md
- …

**Scope is <MVP>. Ask before building anything outside it.**

## Working here

- **The workflow is `.agents/skills/using-agent-skills/SKILL.md`**: Addy
  Osmani's phases (spec, plan, build, test, review, ship) with this project's
  amendments. Skills are invoked by the pipeline, not waited for.
- **Start every session by picking up the handoffs `pnpm bootstrap` lists**
  (it runs at session start), then `/build`, which claims the next ready item
  by pushing a branch named after its ID. `/build auto` works every ready item.
- **`docs/requirements/` is read-only** unless `/kickoff` or `/spec` is running.
  _Enforced by a hook and a `Requirements:` commit trailer._
  `docs/requirements/sources/` is never edited.
- **Every new request goes through `/spec` before work starts.** It triages,
  answers from the repository first, and stops for a person to approve the
  spec (`Approved:`, the one human gate); `plan:check` refuses items from an
  unapproved feature. **A new technology is never added silently**: the
  decision dialog runs, and the user decides.
- **Everything written for an agent meets the five context tenets**: clarity,
  actionability, fidelity, efficiency, security (`docs/kit/principles.md` § 0;
  checklist `.agents/skills/context-engineering/context-quality.md`).
- **Architecture is traceable.** Every app, package and integration in
  `docs/architecture.md` cites a requirement or an ADR. _Pattern check: `plan:check`._
- **Blocked on a person? Ask once, write a `Q-` file, and keep working.**
  Move to the next ready item, do the part every answer needs, or proceed on a
  recorded, reversible assumption (`Assumes:` in the commit). Never idle, and
  never build irreversibly on a guess.
- **IDs are stable and never reused**: `@persona`, `F<nn>`, `F<nn>-R<nn>`,
  `J<nn>`, `F<nn>-<nnn>`, `X-<nnn>`, `Q-<nnn>`. _Pattern check: `plan:check`._
- **An item's status is never written down.** It is derived from git (the
  `Closes:` trailer on `origin/dev`, or a claim).
- **Every session works in a worktree forked from `origin/dev`**, never in the
  main checkout. When the user first asks for something, **propose a name** (from
  the item, `req-<slug>`, or the request) and let them change it before creating
  it. One live worktree per session. _Enforced by hooks._
- **Long-running scripts run in the background**, in a sub-agent or a background
  shell: `ci:local`, test suites, journeys, builds, provisioning. Keep working
  with the user, and report when the result arrives. `ci:local` tests a snapshot,
  so editing can continue meanwhile.
  ```bash
  git worktree add .claude/worktrees/<name> -b <branch> origin/dev
  cd .claude/worktrees/<name> && pnpm install && pnpm bootstrap
  ```
- **"Push it" / "merge it" means: open a PR into `dev`.** Never push directly to an
  integration branch. _Enforced by `pre-push`._
- **`scripts/` is durable; `scripts/one-of/` is throwaway and gitignored.** Put
  a script in `scripts/` when it will run twice or be run by anyone else,
  linted, typechecked and tested. Promote a one-of the second time you need it.
  `tooling/`, `docs/kit/` and the skills are this project's too: change them
  when the project needs it, and offer a general fix to the registry.
  `pnpm sdlc diff <item>` shows what changed upstream; `pnpm sdlc update <item>`
  takes it without overwriting a local edit.
- **Stage by path.** Never `git add -A`. Never `git stash`. The stash is shared by
  every worktree.
- **Commit bodies end with `Progress: <item> — covered; remains`**, plus
  `Closes: <item>` on the commit that finishes it.
- **Attribution trailer:** whatever `.claude/settings.json` says, with no model
  name. _Enforced by `commit-msg`._
- **A branch advances a plan item** (a `Progress:` trailer) or carries a
  `No-Item: <reason>` trailer. The grammar is in `docs/kit/hooks.md`.
  _Enforced by `commit-msg` and `ci:local`._
- **CI is local.** GitHub Actions is off, for cost. `pnpm ci:local` is the full
  gate, and it posts a `local-ci` commit status. **Nothing merges without a green
  status on the exact head SHA.** Do not add workflows without asking.
- **Merge with a merge commit, never squash.** Squashing destroys trailers and
  `Progress:` granularity.
- **Use `pnpm land`** (the only merge path agents have) to take a committed branch to `dev`. It runs `ci:local` and
  refuses to merge without it.
- **Write a handoff before a session ends** (`context-engineering`); the next
  session picks it up, checking every claim in it against `git` before acting
  on it.

## Building

- **Every capability call is an OTel span; logs are structured and carry the
  trace ID.** Only registered attribute keys; no PII, secrets or bodies.
  `console.log` is refused. A capability without a span is not done.
- **Build for the highest threat model** (`docs/kit/security.md`). Authorization goes
  through `@<scope>/authz` (Oso or SpiceDB) with default deny and both checks; every
  input is Zod-validated, including model output; secrets never reach code,
  logs or agents.
- **AI acts only through capabilities** (`docs/kit/ai.md`): an agent's tools _are_
  capabilities, with the caller's permissions ∩ the agent's scope; consequential
  actions are proposed and approved; plain-language BI uses the semantic layer,
  never model-written SQL; every AI feature has an eval and a cost cap.
- **Use vendor CLIs** (`gh`, `wrangler`, …) for provisioning, through idempotent
  scripts; never read their token files.
- **Models go through `@<scope>/llm` (OpenRouter)**, which enforces the routing the
  data class requires. Real user data only on zero-data-retention routes.
  vast.ai only for non-sensitive data, unless an ADR says otherwise.
- **UI follows `docs/requirements/ux.md`**: shadcn/ui on Base UI, tokens only, the screen
  patterns, and all four states (loading, empty, error, populated) on every
  data view. The brief beats a mockup.
- **The domain model is `docs/requirements/domain-model.md`.** A new entity,
  relationship or lifecycle updates it in the same change. Derive, don't store.
- **Logic lives in the port (the `api` package); a route, server function or action
  is transport.** The port takes a resolved `Caller` and never imports the framework.
- **All DB access goes through the ORM client.** No raw SQL. If you think a case
  needs it, stop and ask.
- **A lifecycle is a state machine, and the machine is the only writer of its
  column.** Creation is a transition too, so there is no `@default`. Every event
  needs a sender. _Pattern check: `machine-pattern-check.test.ts`, added with the first
  lifecycle._
- **A third-party service gets its own package, named for the capability, not the
  vendor.** Build the client lazily at call time. Add a vendor-neutral port only
  for an _undecided_ vendor.
- **If the domain has money**: integer cents (`BigInt` columns) through
  `domain/money`. Never a float.
- **Fail loudly, with a unique error code** (`AREA-NNN`).
- **Environment gates are allow-lists.**
- **Never hand-edit or rename an applied migration.** Let the ORM name migrations.

## Testing

- The unit suite never touches the network or a model, and runs with credentials cleared.
- Anything reading or writing rows uses `createTestDb()` (PGlite). **Never write a
  database fake.** _Pattern check: `db-fake-pattern-check.test.ts`._
- Data-access rules (whatever `access-model.md` says: tenant, team, user or
  none) are asserted against a real database, with each refusal paired with
  the same call succeeding for whoever is allowed it.
- Record model responses; do not stub them.
- Prove a guard by tripping it.

## Checks you will meet

| command            | answers                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `pnpm bootstrap`   | is this checkout ready? (prints one line per check)                                                 |
| `pnpm ci:local`    | the full CI gate, run here; posts the `local-ci` status (fingerprinted, so an unchanged tree skips) |
| `/build`           | claims the next ready item and builds it; `/build auto` works every ready item                      |
| `pnpm usage`       | AI cost for every worktree of this repository, from this machine's agent logs                       |
| `pnpm plan:status` | every item's status, derived from git; open questions and what they block                           |
| `pnpm plan:check`  | IDs unique and resolvable; nothing orphaned                                                         |
| `pnpm worktrees`   | live worktrees, who created them, and drift                                                         |

## Rules underneath

A check has three answers (yes, no, _could not ask_), so handle the third on
purpose. Prefer checks that print on success. A CLI renders and does not report;
use `gh api` for compared values. A confident statement is not a check.
