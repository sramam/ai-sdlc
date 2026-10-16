# Tech stack

**Settled** means kickoff confirms it rather than asking about it. **Decide
per project** means kickoff asks, using the criteria given here. Items marked
_verify_ are expectations rather than door_nexa experience. Check them against
current docs in the first spike, and record what you find in the relevant
`agents.md`.

## Settled

|                     | choice                                                                             | notes                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| framework           | **TanStack Start** (React, Vite)                                                   | server functions are the binding; typed search params carry list state in the URL         |
| runtime and hosting | **Cloudflare Workers**                                                             | dev, staging and production as wrangler environments ([environments.md](environments.md)) |
| object storage      | **Cloudflare R2**                                                                  | presigned uploads; the bytes never pass through the Worker                                |
| background work     | **Cloudflare Cron Triggers, Queues, Workflows**                                    | there are no long-running processes on Workers; every job is idempotent                   |
| observability       | **OpenTelemetry**, a first principle                                               | [observability.md](observability.md)                                                      |
| authorization       | **Oso or SpiceDB**, chosen by the access model                                     | [security.md](security.md) § _Authorization_                                              |
| model access        | **OpenRouter**, with data-policy settings enforced                                 | [security.md](security.md) § _Model providers_                                            |
| GPU (if needed)     | **vast.ai**, restricted to the work its trust level allows                         | [security.md](security.md) § _GPU hosts_                                                  |
| UI                  | **shadcn/ui on Base UI primitives + Tailwind v4**, lucide, Inter or the brand font | the playbook is [ux.md](ux.md)                                                            |
| forms               | **React Hook Form + zodResolver**, using the **port's own schema**                 | errors land on the field                                                                  |
| validation          | **Zod**                                                                            | one schema serves server validation, forms, OpenAPI and MCP; money is `z.int()` cents     |
| lifecycles          | **XState**, one machine per entity                                                 | the machine is the only writer of its status column                                       |
| repo                | **pnpm workspace**, TS `strict`, Node 24 for tooling                               | scripts and hooks run with `node`, no `tsx`                                               |
| tests               | **Vitest, PGlite, Playwright**                                                     | [testing.md](testing.md)                                                                  |
| CI                  | **local** (`pnpm ci:local`)                                                        | Actions off by default                                                                    |

## CLIs first

Where a vendor has a CLI, it is how we log in, provision and integrate.
Commands are scriptable, reviewable and repeatable, and a console click is none
of those.

| vendor              | CLI                                | used for                                                                                  |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| GitHub              | `gh`                               | repo settings (squash off; Issues, Projects and Actions off), commit statuses, PRs        |
| Cloudflare          | `wrangler`                         | login, R2, Queues, Hyperdrive, KV and DO per environment, secrets, deploy, rollback, tail |
| Neon (if chosen)    | `neonctl`                          | branches per environment, connection strings                                              |
| vast.ai (if needed) | `vastai`                           | search, create and destroy ephemeral instances                                            |
| Stripe (if chosen)  | `stripe`                           | webhook forwarding locally, test fixtures                                                 |
| others              | their CLI, or their API with a key | where there is no CLI, as with OpenRouter, the key is stored with `wrangler secret put`   |

- **CLIs are pinned** as dev dependencies where they are published to npm
  (`wrangler`, `neonctl`), so behaviour does not change underneath a script.
- **A person runs `login`**, once per machine, through the vendor's browser
  flow. Agents use the logged-in CLI but are **denied reading its token files**
  (`security.md`).
- **Provisioning is a script**, idempotent and per environment
  (`pnpm infra:provision --env staging`), never a sequence of console clicks.
  Running it twice changes nothing.
- **`pnpm accounts:check`** prints a line per CLI: logged in as whom, not logged
  in, or **could not ask**. It uses non-interactive flags and a timeout, because
  a CLI waiting on an invisible prompt looks exactly like "not logged in".
- **No CLI and no API** (for example Lovable): the manual step is written in the
  project brief with its owner, and a check confirms the result where one is
  possible.

## Decide per project (in `/kickoff`)

|                          | options                                                                             | how to choose                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **database**             | **Postgres** (Neon, reached from Workers through **Hyperdrive**) or **D1** (SQLite) | Default Postgres: PGlite tests, branches per environment, the richest constraints. D1 only for small single-tenant apps that want zero external services, and it is **outside the kit**: PGlite tests, database branches and the health check all assume Postgres, so D1 needs an ADR that replaces them. _Verify the Prisma driver adapter and Hyperdrive combination in the first spike_ |
| **ORM**                  | Prisma 7 with a driver adapter, or Drizzle                                          | Prisma for the scoping extension and the door_nexa patterns. Drizzle if the Worker bundle size or cold start hurts. _Verify both on Workers_                                                                                                                                                                                                                                               |
| **auth**                 | Better Auth (passwordless OTP, passkeys) or a hosted provider                       | It must run on Workers (_verify_), support MFA for privileged roles, and keep sessions in the DB or a Durable Object, never only in a JWT you cannot revoke                                                                                                                                                                                                                                |
| **authorization engine** | Oso or SpiceDB                                                                      | decided from `access-model.md` (see security.md)                                                                                                                                                                                                                                                                                                                                           |
| **email and SMS**        | Resend or Postmark; Twilio                                                          | one package each, named for the capability                                                                                                                                                                                                                                                                                                                                                 |
| **OTel backend**         | any OTLP endpoint: Grafana, Honeycomb, Axiom, SigNoz                                | vendor-neutral by construction, so swapping one is configuration                                                                                                                                                                                                                                                                                                                           |
| **payments**             | Stripe, if any                                                                      | idempotency keys derived from stored keys                                                                                                                                                                                                                                                                                                                                                  |

## The architecture shape

```
apps/<app> (TanStack Start on Workers; which apps exist is decided in /kickoff)
  routes, server functions = transport: resolve Caller, start span, call port, invalidate
     │
packages/api      capabilities: authorize (Oso/SpiceDB) + scoped data + state machine + write
   ├── domain/    framework-free schemas, machines, money, dates
   ├── @<scope>/db      DB client; data scope enforced in one place
   ├── @<scope>/authz   the policy engine client and policy; one place to ask "may"
   ├── @<scope>/telemetry  OTel setup, span helpers, redaction
   └── @<scope>/email, @<scope>/storage, @<scope>/llm …   one package per third-party service, named for the capability
```

- **The port imports no framework and no runtime.** No TanStack, React,
  Workers-only globals or `cloudflare:` modules. Runtime bindings (R2, Queues,
  Hyperdrive) are passed in by the binding. That keeps the port testable in Node
  with PGlite.
- **The `Caller` is resolved from a verified session by the binding, never taken
  from a request body.** There are two checks, always both: _may this caller do
  this_ (the authorization engine) and _which rows may it touch_ (data
  filtering from the same engine, or the scoped client).
- **Refusals are returned, not thrown:** `{ ok: false, code, detail, field? }`.
- **Capabilities return identifiers and the facts that changed, never rows.**
- **Every capability call is one span** (see observability.md).

## Workers constraints to design for (_verify each in the first spike_)

- **No long requests.** CPU and wall-time limits apply, so anything heavy goes
  to a Queue or a Workflow, and it must be idempotent.
- **No filesystem, and a partial Node API** (`nodejs_compat`). Libraries that
  assume Node may fail at runtime, not at build. Smoke-test the **built Worker**
  under `wrangler dev`, not only the Vite dev server.
- **Bundle size and cold start.** Keep heavy dependencies out of the request path.
- **Database connections** go through Hyperdrive, never a direct connection per
  request.
- **Bindings differ per environment.** Declare them in `wrangler.jsonc` per
  environment, and validate them at startup the same way as environment variables.

## Client state

- Server state stays on the server, and fetched rows are never copied into a
  store. TanStack Query, if used, is the cache, and there is only one.
- A client store (Zustand) is created per mount, never at module scope.
- A preference the server needs before first paint goes in **one** cookie. A
  shareable question (filters, sort) goes in the URL.

## Money and time

- Integer cents in `BigInt` columns. Guards throw on fractional cents.
- A date boundary is resolved in the zone of the **thing it belongs to**, not
  the server's. Workers run in UTC.

## From door_nexa, kept as lessons

These were Next.js and Vercel specifics, and do not apply to TanStack Start or
Cloudflare. The general lessons do:

- **Restart the dev server after editing a workspace package.** Stale module
  graphs produced a null session in one route type and a valid one in another.
  That reads as an auth bug.
- **A build and a dev server writing the same output directory** clobber each
  other.
- **A framework that writes into your repo** (Next wrote agent rules into
  `AGENTS.md`) must be committed or ignored deliberately.
