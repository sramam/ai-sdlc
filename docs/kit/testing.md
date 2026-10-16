# Testing

The boundary between test tiers is **what each one can prove**.

| tier          | runs against                                                                                                                                               | proves                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| unit          | nothing, with every credential cleared                                                                                                                     | pure logic                                                                                                     |
| contract      | **PGlite**, plus the authorization engine running locally ([security.md](security.md) § _Testing the policy engine_): Postgres in-process, real migrations | the capability builds the right query and Postgres answers it                                                  |
| integration   | PGlite, seeded                                                                                                                                             | data-access scoping (per tenant, team or user, whatever the project's model is), under real Postgres semantics |
| infra guards  | the real hosted DB, **read-only**                                                                                                                          | "this deployment is on the database it claims"                                                                 |
| e2e / journey | browser + seeded DB + dev server                                                                                                                           | a person can get something done                                                                                |
| **smoke**     | browser against the **built Worker** (`wrangler dev`), and after each deploy against the deployed URL                                                      | it works when built and run the way it is deployed, on the Workers runtime                                     |

## Rules that each cost something to learn

**Never hand-write a database fake.** door_nexa's fake grew to 779 lines of the
ORM reimplemented from memory. Replacing it with PGlite exposed:

- **five product bugs**, four of them capabilities that threw on every call
- eight fixture values naming enum members that do not exist
- "fake was wrong, real code looked broken", five times over

Mocking the DB module also substitutes away the **scoping extension**, which is
the thing most worth testing. Enforce the rule with a census that fails on a
`vi.mock` factory that answers queries. A **spy** (`vi.fn()`, asserting what was
written) is fine. A **fake** (returns made-up rows) is not.

**PGlite specifics.**

- About one second to boot with all migrations. Each call is an independent
  database, so there is no truncation step to forget.
- Migrations are applied as SQL in filename order, so a hand-typed timestamp
  breaks it immediately.
- The extension funnels every connection into one session, so set pool `max: 1`.
- Note what you give up: hosted-pooler behaviour, and host-specific settings.

**The unit suite is hermetic, and you must prove it.** vitest `env: {}` does
**not** empty `process.env`, and an app env loader read the developer's
`.env.local` into tests. Locally green, CI red, for a year. Skip env loading
under `VITEST`, then run the suite _with_ a real `.env.local` present and check
that the secrets are undefined inside a test.

**With CI local, this matters more.** door_nexa found the leak only because a
clean hosted runner disagreed with the laptop. With no hosted runner, nothing
disagrees. So `ci:local` must run each suite in a scrubbed child environment,
spawned with an explicit env and not inheriting the shell's. Add a census test
that fails if any test can see a known secret variable. Periodically run
`ci:local` from a fresh clone with no `.env.local` at all.

**Isolation tests pair every refusal with a success.** The other organization
gets `NOT_FOUND`, the owning organization succeeds, and both rows are read back
afterwards. `NOT_FOUND` returned while the update landed anyway is the worst
outcome, and looks identical at the call site.

**Smoke-test the production build early.** Every other tier runs under
`NODE_ENV=test` or `development`. Two auth-cookie bugs (the `__Secure-` prefix)
shipped in one week because nothing ran `production`. Use a real browser, since
the browser is what enforces cookie rules.

**Record model responses; do not stub them.** A stub returns what someone
imagined. Re-record when a prompt changes. Run evals separately, with a pass
threshold, against the production model before a release.

**Coverage: one gate over a merged run.** Merge unit and integration coverage,
or the most-tested module (exercised only through a real client) reads as 54%.
Keep floors in one script that both the gate and the published report read.
Never quote the floor in prose, because the copies drift. vitest per-glob
thresholds were **silently inert** on vitest 4.1, so verify that your gate can
fail.

**Generated artifacts need deterministic generators.** A gate on a
non-deterministic output fails on noise, and people learn to ignore it.

## Journeys: recorded three times, tested once

Journeys are the unit of QA. Each one is a persona, plus a sequence, plus every
refusal that persona can reach. The journey machinery ships in the starter repo
(the `@ai-sdlc/journeys` package in `tooling/journeys/`), so a project writes specs,
not infrastructure ([starter-repo.md](starter-repo.md)).

### The evidence

Each path of each journey records, under `<journey>/<persona>/<path>/`:

- a **screenshot per step**: the reference image a later run is compared against
- a **mask per step**: the regions known to be **data-volatile**, meaning they
  change between two runs of the same build (timestamps, generated IDs, relative
  dates, counts that tick, animations)
- a **narrative**: what the person did and saw, in prose, for a human reviewer
- **captured emails and PDFs**, rendered and compared the same way
- `run.json`: the routes the run **visited**, which drift detection reads

### Recording runs three times (`pnpm journeys:learn`)

| pass            | does                                                                                  | its contract                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. match**    | runs each step and compares it with the committed reference, under the committed mask | a step that matches **keeps the committed image**, so there is nothing to learn. A step that does not match makes this capture the new reference |
| **2. discover** | runs again on the **same build** and diffs against pass 1                             | whatever differs between two runs of identical code is data-volatile, and is added to that step's mask                                           |
| **3. verify**   | runs a third time and applies the learned masks                                       | **the only pass that proves anything.** Red means the masks do not yet hold, and the run exits 1                                                 |

Then `journeys:delta` writes one report, to `test-results/journey-reports/delta.md` (outside the evidence root). For every step whose reference or mask
changed, it shows the old and new reference, the old and new mask, and the pixel
diff under the new mask, beside pass 3's verdict. **Read it before committing a
re-record.** A mask may only grow where its screenshot changed (the _spurious_
rule), and a spurious mask fails the run.

### Testing runs once (`pnpm journeys:test`)

One pass compares every step with the committed reference under the committed
mask. Any unmasked pixel difference is a failure. Testing never learns, never
writes a mask and never updates a reference. **Only recording does**, and a
recording is reviewed in a pull request like code.

### The conditions that keep masks honest

These are door_nexa's expensive lessons, and they come with the machinery:

- **A contended or cold run learns a permanently wrong mask.** A route compiling
  during pass 1, or a slow database pool, makes a step photograph a page that
  has not settled. The union of masks only grows, so the error stays, looking
  exactly like a real volatile region. So:
  - record in **one warm checkout**, one journey at a time, with the routes
    pre-warmed
  - make sure nothing else is recording: the load gate inside `journeys:learn`
    does this as a precondition (exit 75 means held;
    `JOURNEY_LOAD_OVERRIDE="<reason>"` overrides)
  - **discard a contended or abandoned recording** rather than committing it
  - after changing how the stack reaches its database, **relearn from scratch**
- **Recording in parallel checkouts is slower, not faster.** Compilation
  dominates: about 30 seconds of walking against minutes of compiling.
- **Wait for the page to settle**, not for a timer: `aria-busy` clears, then the
  project's `settle.selectors` (journeys config), with DOM mutations watched
  during the shot.
- **Deterministic data** (seed size `demo` or `dev`, fixed random seed, relative
  dates) is what keeps masks small. Every volatile region you can remove at the
  source is one the mask does not have to hide.

### Organising it

- **One spec file per persona**, with the persona in the name:
  `j04-signing-in.organizer.spec.ts` (which resolves to journey `J04`, so registry
  IDs are spelled `J04`), using your own persona IDs, and
  `.common.spec.ts` for refusals that depend on nobody. A census checks the name
  against the persona registry.
- **Indexes are generated from disk.** Never hand-merge a generated table;
  re-run the generator.
- **Capture transports** (email to disk, storage in a local directory) let a
  journey read the sign-in code and download its upload. They are refused on
  every deployment.
- **Ports are derived per checkout**, and the sweep kills only this checkout's
  listeners.
- **Drift detection**: `journeys:drift` maps the routes a PR changed to the
  journeys whose recordings visited them, and requires a re-record or a
  a `No-Rerecord: J<nn> <reason>` commit trailer (one journey per trailer; the reason is required). It cannot see a shared component with no
  route, so nothing reported is not proof that nothing moved.
- **Released to QA by a person.** `/journey-ready-for-qa` adds the sign-off.
  Green says the paths that exist pass; it cannot say the right paths were
  written.

### Storing it

door_nexa committed its recordings to git: **196 MB** in `docs/journeys/`, which
grew with every re-record. References and masks must be versioned with the code,
because a re-record is reviewed in a PR, so:

- **Store screenshots, masks and rendered emails in Git LFS**, configured in the
  starter's `.gitattributes`. Narratives and `run.json` stay as plain git.
- Keep only the **current** reference per step. History lives in git, not in
  extra files.
