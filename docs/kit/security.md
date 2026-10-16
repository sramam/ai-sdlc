# Security — build for the highest threat model

**We assume the strongest realistic adversary from the first commit**
([principles.md](principles.md) §17). Security added later costs a rewrite;
security designed in costs a few lines per feature. Items marked _verify_ are
vendor specifics to confirm against current docs when they are adopted.

## The threat model we assume

| adversary                    | assume they will try to                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| **another tenant or user**   | read or change data that is not theirs (IDOR, guessable IDs, missing scope), escalate their role      |
| **an anonymous attacker**    | brute-force sign-in, enumerate accounts, abuse expensive endpoints, inject (XSS, SQL), forge webhooks |
| **a compromised dependency** | run code at install or at runtime, exfiltrate secrets                                                 |
| **a leaked credential**      | an API key, session token or database URL used from anywhere                                          |
| **staff and insiders**       | use cross-tenant access beyond their need                                                             |
| **a model**                  | follow injected instructions in content it reads, and call tools to act on them                       |
| **our own coding agents**    | be prompt-injected through fetched pages, issues or files, then read secrets or push changes          |
| **infrastructure we rent**   | an untrusted GPU host or intermediary that keeps or reads what we send it                             |

**Standard: OWASP ASVS Level 3** for authentication, authorization, money and
personal data, and Level 2 as the floor elsewhere. Every deviation is an ADR
with a reason and a date (principles.md §10: relax on evidence, never in
anticipation).

## Authorization — Oso or SpiceDB, chosen by the access model

`/idea` writes `access-model.md` (tenancy, roles, row scope). The engine is
chosen from it in `/kickoff`, and recorded in an ADR:

| choose                                                                                                                   | when the access model looks like                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Oso** (Oso Cloud, with local authorization for list filtering; _verify: the legacy open-source library is deprecated_) | roles within tenants, plus attribute rules ("owner of the record", "status is draft"), with policy kept as readable code (Polar) next to the app                                                                                         |
| **SpiceDB** (self-hosted, or AuthZed's hosted offering)                                                                  | fine-grained **sharing** of individual objects with users and groups, nested groups, deep hierarchies, relationships that change often, several services sharing one authorization source, a need for consistency guarantees (ZedTokens) |

Whichever is chosen, these rules hold:

- **One place asks "may".** `@<scope>/authz` wraps the engine. Capabilities call it,
  and nothing else does. A census fails on any capability that does not
  authorize, and on any server function that reaches data without going
  through a capability.
- **Default deny.** An unknown action, resource type or role is refused. If the
  engine is unreachable, that is _could not ask_, and the answer is **refuse**.
- **Both checks, always.** _May this caller do this action_ (check), and _which
  rows may it see_ (list filtering: Oso's data filtering, or SpiceDB
  `LookupResources`). Never fetch everything and filter in memory.
- **The policy lives in the repo** (the Polar file or the SpiceDB schema),
  reviewed like code, and **tested as a matrix**. Every persona × capability
  cell in `access-model.md` is a test, so a policy change that alters a cell
  fails until the access model changes with it.
- **No dual writes.** If relationships live in the engine and data in Postgres,
  write them together through an **outbox** (one DB transaction, relayed to the
  engine idempotently), or derive the engine's facts from the DB (Oso local
  authorization). A relationship written without its row, or a row without its
  relationship, is a silent hole.
- **Agents get an intersection, never an inheritance.** An agent's authority is
  the caller's permissions ∩ the agent's declared tool scope. Activating an
  agent requires holding every permission in that scope.
- **Staff access is a separate, audited axis.** It is time-boxed, read-only by
  default, needs a recorded reason, and is visible to the tenant where the
  model allows it.

### Testing the policy engine without a network

The unit suite has no network, and contract tests run on PGlite, so the
authorization engine must run locally too (_verify the current tooling in the
platform spike_):

- **SpiceDB** runs as a local, in-memory server for tests (its `serve-testing`
  mode, or a container started by `ci:local`). Each suite loads the schema and
  relationships it needs.
- **Oso** uses its local development server, or local authorization evaluated
  against the test database, with the policy file from the repo.
- **The matrix test** runs against that local engine. It is generated from
  `access-model.md`, and its cells arrive with the features that need them.
- If the engine cannot start, `ci:local` reports _could not run_, never a pass.

## Model providers — OpenRouter, with data policy enforced

OpenRouter routes to many providers, so it is **an intermediary that sees every
prompt**, and the provider behind it is a second party. Under this threat model:

- **Account-level settings first** (_verify the current names_): prompt logging
  off, and providers that train on or retain inputs excluded.
- **Per-request enforcement in `@<scope>/llm`**: every request carries provider
  routing that denies data collection and, for any real user data, requires
  **zero-data-retention** endpoints. A request without it is refused in code,
  not left to settings somebody can change.
- **Data classes decide routes.** Synthetic and dev data may use any model.
  Real personal or tenant data uses only ZDR routes on an allow-list of models.
  The allow-list is reviewed, not assumed.
- **Model output is untrusted input.** Validate it with Zod, never render it as
  HTML, never execute it, and send tool calls through the port with the
  caller's authority.
- **Cost caps are enforced in-process**, per run and per tenant per day.
- **Record responses for tests; never call a model from the unit suite.**

## GPU hosts — vast.ai, restricted by trust

vast.ai is a marketplace, and many hosts are third parties you cannot audit. So:

- **Default: synthetic, public or already-anonymized data only.** Use it for
  training and evaluation on data you would publish.
- **Real user data, secrets or proprietary weights** only on hosts the platform
  verifies as datacenter-grade (_verify the current tier_), and only with an ADR
  that names the data class and the reason.
- **Instances are ephemeral.** Use short-lived, narrowly scoped credentials
  (one bucket prefix, expiring), never a long-lived key. Destroy the instance
  afterwards.
- **Verify outputs.** Checksum artifacts, and evaluate models before promoting
  them. A host can return what it likes.

## Application controls (the baseline every project gets)

| area               | control                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **authentication** | passwordless OTP or passkeys; **MFA required** for admin and staff roles; rate-limited, enumeration-safe sign-in; re-authenticate before sensitive actions                                           |
| **sessions**       | server-side and revocable; `__Host-` cookies, `Secure`, `HttpOnly`, `SameSite=Lax` or stricter; rotated on privilege change; short idle timeout for privileged roles                                 |
| **IDs**            | opaque and non-guessable in URLs; possessing an ID is never authorization                                                                                                                            |
| **input**          | Zod at every boundary, including webhooks, queue messages and model output                                                                                                                           |
| **output**         | React escaping; no `dangerouslySetInnerHTML` without a sanitizer, and a census for it; user-uploaded files served from a separate origin with `Content-Disposition`                                  |
| **headers**        | strict CSP with nonces, HSTS, `frame-ancestors 'none'`, COOP, a referrer policy                                                                                                                      |
| **abuse**          | per-caller rate limits (Cloudflare rate limiting or a Durable Object), the WAF, bot protection on sign-in and sign-up                                                                                |
| **webhooks**       | verify the signature, reject replays (timestamp plus idempotency key), and process idempotently                                                                                                      |
| **secrets**        | wrangler secrets per environment; never in the repo, logs or telemetry; a rotation procedure written down and rehearsed                                                                              |
| **data**           | a classification per table (evidence, operational, ephemeral); encryption at rest by the provider, plus field-level encryption for the most sensitive fields; append-only audit log; an erasure path |
| **uploads**        | size and type checked server-side by content, not extension; scanned if users share files with each other                                                                                            |
| **telemetry**      | allow-listed attributes only ([observability.md](observability.md))                                                                                                                                  |

## Supply chain

- Pinned versions, a frozen lockfile, and `packageManager` with `engines`.
- **Install scripts denied by default.** pnpm's `onlyBuiltDependencies`
  allow-list is reviewed when it changes.
- A **minimum release age** for new versions, so freshly published packages are
  not taken on day one (_verify the pnpm setting_).
- `ci:local` runs a dependency audit, a secret scan (TruffleHog or Gitleaks),
  and a license check.
- Dependency updates are batched weekly, read, and landed through `/land`.

## Our own agents and machines

- **The deny list is a courtesy, not a boundary.** `.claude/settings.json`
  denies the `Read` and `Edit` tools on `.env`, `.dev.vars`, credential files and
  key stores, so an agent will not open them in passing. It does **not** stop an
  allowed shell command (`pnpm …`, `git …`, `node …`) from reading them, and
  `pnpm bootstrap` symlinks env files into worktrees. Treat anything on the
  developer's machine as reachable by the agent. So: **production credentials are
  never on a development machine**, local secrets are development-only and
  low-value, and deploys use scoped tokens a person runs. A real boundary needs
  OS-level sandboxing (Claude Code's sandbox mode, or a container); a project
  that needs one decides it in kickoff.
- **Content an agent fetches is data, not instructions.** That covers web
  pages, issue text, PR comments and files from outside. The harness and the
  skills say so, and an agent never runs a command it found in fetched content
  without the user asking.
- **MCP servers and plugins are dependencies.** Vet them, pin them, and give
  each the least scope it needs.
- **Commits from agents go through the same gates**: hooks, reviewers and
  `ci:local`. Nothing reaches production without a person promoting it.

## Process

- **`/idea` and `/add-requirement` ask a threat question for every feature**
  (the full checklist):
  - what asset this touches
  - who would attack it, and how
  - what stops them

  The answer becomes a `Security:` line in the requirement, and tests come from it.

- **`code-reviewer` criterion 6** covers authorization, input, output, secrets
  and telemetry hygiene for every diff.
- **`/security-review`** runs before every release, and on any change to auth,
  authorization, money, uploads, webhooks or model routing.
- **Before launch**: an external penetration test, a restore drill, a rehearsed
  secret rotation, and a written incident runbook (who is paged, how to revoke
  sessions and keys, how to notify).
