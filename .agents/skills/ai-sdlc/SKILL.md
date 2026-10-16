---
name: ai-sdlc
description: How this ai-sdlc project is put together and how to extend it — what `init` installed, the optional modules, recipes and skills and when each is needed (`pnpm sdlc list`), where every kind of file goes, how to configure sdlc.config.json, and how to take upstream fixes. Use when setting up the project, when the work needs a capability that is not installed yet, when unsure where a file belongs, or before changing the tooling.
---

# Working with an ai-sdlc project

This project was created from the ai-sdlc registry, in the way a shadcn/ui
project takes components: it started minimal (base) and adds pieces as the work
needs them. Every file it received is the project's own, to read, change and
fix.

## What base gave you

- **The workflow**: Addy Osmani's agent-skills (verbatim in
  `.agents/3rdparty/agent-skills/`) and their wrappers in `.agents/skills/`;
  the map is `using-agent-skills`. Ours: `kickoff`, `progress-report`, this
  one, and `journeys` with its module.
- **The kit**, `docs/kit/`: the specification and its reasons.
- **The guards and gates**: `.husky/`, `.claude/settings.json`,
  `tooling/{core,guards,plan,ci,setup}`, `pnpm ci:local`, `pnpm land`.
- **The scaffold**: `docs/requirements/`, `docs/plan/` (with `X-000` and
  `X-001`), `docs/adr/`, `docs/handoffs/`, `docs/progress/`, `sdlc.config.json`.

No product code. Apps and packages are decided in `/kickoff` (topic 9).

## Adding pieces as you go

1. **Only what a decision calls for.** Kickoff names the items the project
   starts from, and the foundation items (`X-` in `docs/plan/items/`) add them.
   Later, add one when a plan item needs it and its `add it when:` line (in
   `pnpm sdlc list`) fits. A new technology still goes through the decision
   dialog first (`docs/kit/technology-decisions.md`).
2. `pnpm sdlc add <item…>` copies it and what it requires, merges its scripts,
   dependencies and config, and prints its notes. Read the notes: some items
   need a CLI, an account or a key.
3. `pnpm install`, then adapt it to the decisions (scope, names), keeping its
   tests green. Commit each item on its own, citing the item that needed it.

Kinds: a **module** is tooling in `tooling/<name>/` (journeys, localdb, seed,
coverage, promote, security); a **recipe** is reference code at the place its
README names; a **skill** is a third-party skill in `.agents/3rdparty/` with
its wrapper in `.agents/skills/`. Some skills are referenced, not copied
(`docs/kit/skills.md` § _Optional skills_).

## Where things go

| what                                      | where                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| an app (decided in kickoff)               | `apps/<app>/`, with its own `agents.md`                                               |
| a package: api, bindings, db, authz, llm… | `packages/<name>/` (`@<scope>/<name>`), with its own `agents.md`                      |
| the shape between them                    | `docs/kit/tech-stack.md` § _The architecture shape_: one port, three bindings         |
| journey specs and the stack adapter       | `e2e/`                                                                                |
| requirements                              | `docs/requirements/` (only `/kickoff` and `/spec` write it)                           |
| plan items and open questions             | `docs/plan/items/`, `docs/plan/questions/`                                            |
| decisions                                 | `docs/adr/ADR-<nnn>-<slug>.md`; `docs/architecture.md` cites each                     |
| a script run twice or by anyone else      | `scripts/`; a throwaway goes in `scripts/one-of/` (gitignored)                        |
| tooling the project changes               | the module's `tooling/<name>/`                                                        |
| a skill or an amendment                   | `.agents/skills/<name>/` (Claude Code sees it through `.claude/skills/`)              |
| a prompt the product sends to a model     | one file beside its eval, in the package that calls `@<scope>/llm` (`docs/kit/ai.md`) |

`docs/kit/registry.md` § _Layout of a new project_ has the full base tree.

## Configuring

`sdlc.config.json` is the one file that configures the tooling: branches
(fixed: `dev`, `staging`, `main`), directories, the accounts `pnpm
accounts:check` confirms, the reporting cadence, the CI steps, coverage floors,
local databases and seeds. It is validated against `tooling/core`'s schema, and
CI reads it from `origin/dev`, never from the branch under test. Items merge
their own entries into it; a value the project set is never overwritten.

## Taking upstream fixes

- `pnpm sdlc diff <item>` shows what changed here and what changed upstream.
- `pnpm sdlc update <item>` applies an upstream change only to a file still as
  it was copied, and lists the rest with the upstream diff, to fold in by hand
  (then `--accept <file>`).
- Never edit a file under `.agents/3rdparty/`: amend in the wrapper beside it,
  so the next update applies cleanly.
- A fix every project would want goes to the registry too
  (`progress-report` step 4).

## Now

Run these and read their output before deciding what to add:

```bash
pnpm bootstrap      # what this checkout has, and what is missing
pnpm sdlc list      # every item, whether it is installed, and when to add it
```
