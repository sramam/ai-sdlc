# @ai-sdlc/core

Shared by every other module: the `sdlc.config.json` loader, the command runner (`exec`), and the one git-command parser every guard uses.

The project's own: it arrives with `ai-sdlc init`, and is changed here when the project needs it. `pnpm sdlc diff base` shows what changed upstream; `pnpm sdlc update base` takes it without overwriting a local edit (docs/kit/registry.md).

## `sdlc.config.json`

**Declarative, and never executed.** It was `sdlc.config.ts`, imported as a module — and `ci:local` imported it from the commit under test, so a branch could run code in the CI process by editing its config. It is strict JSON now, read and validated by `src/config.mts` with no dependency (hooks run before `pnpm install`), and `ci:local` reads the CI definition from `origin/<integration>`, so a branch's change to it takes effect only once it lands.

- **An unknown key is an error** naming the key and where it is (`ci.steps[2]: unknown key "histroy"`); a wrong type names the path (`claimStaleDays: expected a number, got string`). A typo is refused rather than ignored.
- **`src/config.schema.json`** is generated from the validator's shape for editors: `node tooling/core/src/config-schema.mts --write` after changing `SHAPE`; `--check` and `config.test.ts` fail when it is stale or disagrees with the validator.
- **`loadConfig(root)`** reads the working tree's file; **`loadConfigAt(root, ref)`** reads it as committed at a ref (`null` when that commit has none).
- **`configVersion`** (default 1) is the file's format. A release that changes the format raises it, and the item's notes (printed by `pnpm sdlc update`) say how to convert.

JSON has no comments, so the documented examples live here.

**An account with no CLI** — a manual step and its owner:

```json
{
  "accounts": [
    { "name": "Neon", "cli": "neonctl", "check": ["me", "--output", "json"] },
    { "name": "Lovable", "cli": null, "check": [], "manual": "owner signs in at lovable.dev" }
  ]
}
```

**CI steps.** `applies` is one of `always`, `has-apps`, `has-packages`, `has-source`, `has-plan`; `env` names the only variables the step may see; `history: true` marks a step that reads a commit range, so it runs even when the content checks are cached (tooling/ci). The foundation items add build, smoke, contract, coverage, journeys and the secret scan.

```json
{
  "ci": {
    "steps": [
      {
        "name": "trailers",
        "run": "node tooling/guards/src/trailers.mts --range",
        "applies": "always",
        "history": true
      },
      {
        "name": "contract",
        "run": "pnpm run test:contract",
        "applies": "has-packages",
        "env": ["DATABASE_URL"]
      }
    ],
    "container": { "image": "node:24-bookworm", "engine": "docker" }
  }
}
```

`ci.container` is used by `pnpm ci:local --container`: install and every step run inside the image, with only the snapshot mounted and only the scrubbed environment passed in. `network` is optional and passed as `--network`.

**A per-checkout database** (`pnpm db:local`, tooling/localdb). `migrate` is the project's own command, run with `DATABASE_URL` pointing at the database; `env` names extra variables that receive the same URL. Added by the foundation items once there is a schema.

```json
{
  "localdb": {
    "databases": [
      {
        "name": "app",
        "migrate": "pnpm --filter @app/db exec drizzle-kit migrate",
        "env": ["CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE"]
      }
    ]
  }
}
```

**Mock data** (`pnpm seed`, tooling/seed). Only apps that need it appear; `database` must name a `localdb` database.

```json
{
  "seeds": [
    { "app": "web", "run": "pnpm --filter @app/web run seed", "database": "app" },
    { "app": "admin", "run": "node apps/admin/scripts/seed.mts", "sizes": ["dev", "demo"] }
  ]
}
```

**Coverage floors:**

```json
{
  "coverage": { "floors": { "packages/db": { "lines": 95, "branches": 90 } } }
}
```

`cadence.progressReportWeekdays` counts 0 = Sunday … 6 = Saturday (`[1, 4]` is Monday and Thursday).
