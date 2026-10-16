# @ai-sdlc/seed

`pnpm seed` — deterministic mock data, opt-in per application — and the small
helper library a seeder imports (docs/kit/data-model.md § _Seed and demo data_).

## Configure

Only applications that need mock data appear:

```json
{
  "seeds": [
    { "app": "web", "run": "pnpm --filter @app/web run seed", "database": "app" },
    { "app": "admin", "run": "node apps/admin/scripts/seed.mts", "sizes": ["dev", "demo"] }
  ]
}
```

A top-level key of `sdlc.config.json`.

`database` names a `localdb` database; `sizes` defaults to `["test", "dev", "demo"]`.
`run` is a shell command, run from the repository root.

## Run

```
pnpm seed                         every declared app, size dev, target local
pnpm seed web --size demo
pnpm seed --target staging        DATABASE_URL from the environment
pnpm seed --today 2026-01-31      pin "today" (dates are relative to it)
```

Each seeder gets, whatever the environment says:

| variable                                                                         | value                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `SEED_APP`, `SEED_SIZE`                                                          | the app and size                                                                      |
| `SEED_RANDOM`                                                                    | `--random`, else `$SEED_RANDOM`, else `ai-sdlc`                                       |
| `SEED_TODAY`                                                                     | `--today`, else `$SEED_TODAY`, else this machine's calendar date (YYYY-MM-DD)         |
| `SEED_TARGET`                                                                    | `local`, `dev` or `staging`                                                           |
| `DATABASE_URL`                                                                   | target local: the app's running localdb (and its `env` names); else the environment's |
| `EMAIL_TRANSPORT=capture`, `STORAGE_TRANSPORT=local`, `MODEL_TRANSPORT=recorded` | forced — a seed never sends                                                           |

It prints one line per app with its duration, and exits 1 if any seeder failed.

## Refusals (decided before any seeder runs)

- a target other than `local`, `dev`, `staging` — **production is never seeded**,
  and an undeclared target gets the restrictive answer
- target `local` with a `DATABASE_URL` that is not one of this checkout's
  running localdb databases; target `dev`/`staging` with one that is
- an app's `database` not running (names `pnpm db:local start <db>`), or not declared
- an app not in `seeds` (names the configured ones); a size the app does not declare
- a `--today` that is not a real `YYYY-MM-DD`

No `seeds` at all prints `no application declares seed data` and exits 0.

## Helpers — `@ai-sdlc/seed/helpers`

Dependency-free, with no `node:` imports, so a seeder in any runtime can use it.

```ts
import {
  createRandom,
  pick,
  int,
  days,
  stableId,
  fromCaptured,
  isSeedId,
} from "@ai-sdlc/seed/helpers";

const r = createRandom("people"); // mulberry32; seed defaults to SEED_RANDOM
const name = pick(r, FIRST_NAMES);
const rent = int(r, 900, 2400) * 100;
const { date, iso } = days(-45); // relative to SEED_TODAY
const id = stableId("person", 7); // 5eedxxxx-xxxx-8xxx-…, same every run
const address = fromCaptured(ADDRESSES, 7); // captured real values, index wraps
isSeedId(id); // true — find and delete seed-owned rows
```

Upstream-owned: changed in the ai-sdlc starter, pulled with `pnpm sdlc:update`.
