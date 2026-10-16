# ai-sdlc

A starter for projects built by AI agents and people together. It carries the
SDLC (skills, hooks, guards, local CI, the plan tooling, the journey machinery
and the docs) and **no product code**.

## Start a project

```bash
gh auth login && wrangler login
gh repo create <org>/<name> --template <org>/ai-sdlc --private --clone
cd <name> && git remote add starter https://github.com/<org>/ai-sdlc.git
pnpm install && pnpm sdlc:init
```

Then ask your agent: _"Read `docs/kit/BOOTSTRAP.md` and follow it. Start with
`/kickoff`."_

## What is here

| path               | what                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `docs/kit/`        | the kit: how this way of working is meant to run, and why ([README](docs/kit/README.md))                    |
| `.claude/skills/`  | `kickoff`, `idea`, `add-requirement`, `plan`, `land`, `handoff`, `pickup`, `progress-report`, the reviewers |
| `tooling/`         | the tooling, one replaceable package per module: `core`, `guards`, `plan`, `ci`, `setup`                    |
| `sdlc.config.json` | the only file a project edits to configure the tooling                                                      |
| `docs/plan/items/` | `X-000` (discovery) and `X-001` (configure), which every project starts with                                |

## Status

**Not ready to publish.** Built: the skeleton, hooks, settings, skills, docs,
and the `core`, `guards`, `plan`, `ci` and `setup` modules with tests. In
progress: `journeys`, `localdb`, `seed`. Not yet: coverage, promote, the
`/security-review` and `/release` skills, and the recipes (`docs/kit/recipes/`).
Where the kit describes something not yet built, it says _planned_.
