# Environments — dev, staging, production on Cloudflare

**Four environments: local (per checkout), plus three deployed ones (dev,
staging, production)**, declared as wrangler environments in one
`wrangler.jsonc`. Two clarifications make them work.

1. **"dev" means the shared integration deployment, not your laptop.** Local
   is not deployed. Each checkout runs against its **own** database
   (PGlite in tests; for the dev server, a per-checkout local Postgres from
   `pnpm playground`, which Hyperdrive's local connection string points at
   under `wrangler dev`, _verify the setting name_), never the shared dev database. door_nexa's shared dev database,
   written to by every agent, caused migration drift that nobody could create a
   migration past.
2. **Previews per branch are optional.** Workers can upload a version with a
   preview URL without promoting it (_verify the current mechanism_). If you
   use previews, each one gets its own database branch or a seeded throwaway,
   never the shared dev database.

|                | git branch | Worker env            | database                                          | data                                                   | used by                      |
| -------------- | ---------- | --------------------- | ------------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| **local**      | any        | `wrangler dev` / Vite | per checkout                                      | deterministic seed                                     | the agent or developer       |
| **dev**        | `dev`      | `dev`                 | dev branch, through its own Hyperdrive config     | deterministic seed; reset freely                       | the team, integration checks |
| **staging**    | `staging`  | `staging`             | staging branch, through its own Hyperdrive config | deterministic **demo** seed; **never production data** | QA, stakeholders, demos      |
| **production** | `main`     | `production`          | production, through its own Hyperdrive config     | real                                                   | users                        |

Each environment has **its own** R2 buckets, Queues, Hyperdrive config, KV and
Durable Object namespaces, secrets and OTel resource attributes
(`deployment.environment`). Nothing is shared across environments.

## Local: a PGlite database per worktree

Every worktree has **its own** Postgres (PGlite, served on a port derived from
the checkout), under `.localdb/<db>/` in that worktree. Nothing local is
shared, so an agent can change a schema or wipe data and nobody else notices:

```bash
pnpm db:local start            # one server per configured database; prints DATABASE_URL
pnpm db:local migrate          # snapshots first (pre-migrate-<time>), then runs the project's migrate command
pnpm db:local snapshot before-x
pnpm db:local restore before-x # undo whatever happened since
pnpm db:local reset            # empty, then migrate
```

- **Revertible by construction**: every migration is preceded by an automatic
  snapshot, and any state can be snapshotted by name. Reverting a schema
  experiment is one command, and never touches another agent's data.
- **Databases are declared in `sdlc.config.json` (`localdb.databases`)**, each with
  the project's own `migrate` command, because the ORM is the project's choice.
  An app needs a database only if kickoff topic 9 says so.
- **Removing the worktree removes its database.** Nothing outlives the branch
  that made it.
- **Shared environments (dev, staging, production) are never reached from a
  worktree for experiments.** Migrations reach them only through promotion.

## Deploying, with no hosted CI

- **Promotion is fast-forward only**: `dev → staging → main`, done by
  `pnpm promote:staging` and `pnpm promote:prod`, run by a person. Never merge
  a pull request into `main`. Each script:
  1. refuses unless the target SHA has a green `local-ci` status
  2. runs migrations against that environment's **direct** (non-Hyperdrive)
     connection
  3. `wrangler deploy --env <env>` from that exact SHA, with a clean tree
  4. fast-forwards the git branch
  5. smoke-tests the deployed URL (sign in, reach a page) and fails loudly
- **Deploy tokens are scoped** to one account and the Workers, R2 and Queues
  permissions needed. They are never on agents' machines, and they are used only
  by the promote scripts.
- **Rollback** is `wrangler rollback` to the previous version. The schema stays
  forward, so migrations are additive first (see [data-model.md](data-model.md)).
- Cloudflare's own git integration (Workers Builds) is an alternative to
  deploying from a laptop. If adopted, keep `local-ci` as the gate and let the
  integration deploy only branches that already passed.

## Rules

- **Each deployment checks it is on the database it claims.** The environment
  declares its database branch, and `/api/health` compares that with what the
  session reports (door_nexa's branch verdict). It reports the verdict, never
  topology.
- **Environment gates are allow-lists.** Name where a privilege applies, never
  where it does not: seeding, staff self-sign-up, email capture, local storage.
  An undeclared environment gets the restrictive answer.
- **Seeding refuses production**, and refuses an undeclared environment.
- **Production data never flows down.** If you must debug against it, use a
  short-lived, access-restricted branch, run read-only checks only, and delete
  it afterwards.
- **Secrets** are set with `wrangler secret put` per environment. Bindings and
  variables are validated by a schema at startup, failing loudly with the name
  of anything missing. `.env.example` and `.dev.vars.example` list everything,
  and a census keeps them in step with the schema.
- **Capture transports** (email to disk, local storage) are refused on every
  deployed environment, at build time and at call time.
- **Backups**: rely on the database host's point-in-time recovery, and R2
  versioning where data matters. Know the retention windows. **Practise one
  restore before launch.**

## What the bootstrap sets up

- `wrangler.jsonc` with the three environments and their bindings, and
  `.dev.vars.example`
- `apps/<app>/src/env.ts`, from the `env-schema` recipe: the schema for
  variables **and bindings**, with deployment-only rules
- `pnpm promote:staging` and `pnpm promote:prod`, as above
- `/api/health` with the database-branch check
- seeding scripts that refuse production (see [data-model.md](data-model.md) § _Seed and demo data_)
