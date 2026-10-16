# The domain model: discovered early, designed for simplicity

**`/kickoff` discovers the high-level domain objects** as part of the PRD (stage
2): what they are, how they relate, which have a lifecycle, and who owns each
one (from the access model). Stage 3 reads the result when it settles the
stack. Fields
and details are worked out as the project develops, one plan item at a time.

## Discovering it (in `/kickoff`)

1. **Harvest the nouns** from the BRD, the features and the journeys. Merge
   synonyms using `glossary.md`. A thing with two names becomes two tables.
2. **Keep only the things the product must remember.** Everything else is an
   attribute, a computed value or a log line.
3. **For each object, record:**
   - a one-line definition, in the user's words
   - who owns it: its tenant or scope, from `access-model.md`
   - its relationships, with cardinality
   - **does it have a lifecycle?** If so, list its states and the events
     between them, and who or what sends each event
   - how it is created and how it ends (archived, deleted, kept forever)
   - the hot access paths: the journeys that read or write it most, and how
     they find it
4. **Draw it**: one mermaid ER diagram, high level, with no field lists.
5. **Review it with the author** against the journeys. Walk each one across the
   diagram, and look for a step that needs data nothing holds.

Output: `docs/requirements/domain-model.md`, plus an ADR for any structural choice.
Unsure objects are marked `provisional`, with a `Q-` file.

## Design rules

### Simplicity

- **One concept, one table, one name.** Use the glossary word, the same in
  code, schema, UI and docs.
- **Fewest entities that hold the journeys.** Do not model a "type" table, a
  settings table or a polymorphic link until a second real case needs it.
- **Derive, don't store.** A status computed from other rows (paid, overdue,
  occupied, active) is a query or a view, not a column. Store only what a
  person or an event _decided_.
- **A lifecycle is a state machine**, one per entity, and the machine is the
  only writer of its status column. Creation is a transition, so the column has
  no schema default. Machines describe one axis each and do not combine.
- **Relationships carry roles.** A person's role belongs to their membership in
  a tenant, not to the person.

### Correctness that is cheap now and expensive later

- **Money**: integer minor units (`BigInt` cents), never floats. One currency
  column if there could ever be two.
- **Time**: instants as `timestamptz`. A _date_ belongs to the zone of the thing
  it concerns, so store that zone on the thing.
- **IDs**: opaque and non-guessable for anything exposed in URLs.
- **Every scoped row carries its tenant ID**, and is indexed by it.
- **Audit and evidence tables are append-only.** Classify every table's
  retention: evidence, operational or ephemeral.
- **Nullable means "unknown or not applicable", stated in a comment.** Never
  fake NOT NULL with a sentinel value.

### Operational and execution efficiency

- **Design from the access paths.** Each hot journey step names the query it
  needs, and the index exists for that query, not for the column list.
- **Index every foreign key you look up by.** Postgres does not do this for
  you, and a composite index starting with the tenant ID cannot serve a lookup
  by the foreign key alone.
- **Watch for costs that are superlinear in history.** A correlated nested
  `include` runs once per row. Seed realistic volumes (a year of history) and
  time the hot queries.
- **Bulk writes in one statement or transaction**, never one round trip per
  row.
- **Soft delete (`archivedAt`) only where a person needs undo or history.**
  Otherwise delete, and let retention rules govern evidence.
- **Migrations are additive first.** Add a column nullable, backfill it, then
  enforce it a release later. Deprecate before dropping.

## Seed and demo data: deterministic

**Mock data is opt-in, per application.** Kickoff topic 9 decides which. Each one is declared in `sdlc.config.json`
(`seeds`), with the command that seeds it and the local database it targets,
and `pnpm seed [app] --size <size>` runs it through the `@ai-sdlc/seed`
runner. The runner gives every app the same contract:

- **Determinism inputs** in the environment: `SEED_SIZE`, `SEED_RANDOM` (a
  fixed seed for the PRNG) and `SEED_TODAY` (the base for relative dates).
- **Shared helpers** (`@ai-sdlc/seed` helpers: a seeded PRNG, `days(n)`,
  `stableId()`, captured-fixture lookup), so every app is deterministic the
  same way.
- **Capture transports forced**: email, storage and model calls never leave the
  machine during a seed.
- **An allow-list of targets**: the worktree's own database, dev or staging.
  Production, or any target not declared, is refused.

Seeds exist at three sizes, and they are the same code at every size:

| seed   | for                            | size                                                          |
| ------ | ------------------------------ | ------------------------------------------------------------- |
| `test` | fixtures inside tests          | the smallest valid graph per test                             |
| `dev`  | local, and the dev environment | a little of everything, including every state                 |
| `demo` | staging, demos, screenshots    | realistic volume and history (for example a year of activity) |

- **Deterministic**: a fixed random seed, so names, amounts and IDs are
  identical on every run. Screenshots and assertions can rely on them.
- **Dates relative to today**, never literal dates. "Expires in 45 days" stays
  true next month.
- **Every state appears**, including the awkward ones, such as a record
  between sweeps or a lifecycle at every stage.
- **Real-shaped values come from captured fixtures**, not random generators,
  whose addresses the product's own validation rejects. Capture a small set of
  real values once, commit them, and index into them.
- **Idempotent**: re-running produces the same database. Use upserts on fixed
  IDs, or delete-and-recreate of seed-owned rows (prefix their IDs).
- **History is produced by running the real jobs** with an injectable clock
  (`run({ now: thatMonth })`), not by writing end states directly. Where an external system
  is required (a payment webhook), fold the events through the state machine,
  so every stored status is one the machine can reach.
- **Demo data is used "when appropriate"**: always in dev and staging, and in
  production only as an explicit, isolated demo tenant created through the
  product's own provisioning, never mixed with real tenants.
- The seed prints where its time went, by step. The slow step usually points
  at a bad query pattern in the product, not at the seed.

## Growing it

The high-level model is decided in discovery. Fields arrive with the plan items
that need them. A change to the high-level model (a new entity, a changed
relationship, a new lifecycle) goes through `/spec` and updates
`domain-model.md` in the same change. `plan:check` fails on an entity named in
a requirement that `domain-model.md` does not define.
