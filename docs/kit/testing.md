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

**Never hand-write a database fake.** A fake is the ORM reimplemented from
memory, so it hides product bugs and makes real code look broken. The
commit-time code review checks the rule (project
criteria 1); a project adds a pattern check that fails on a `vi.mock` factory
answering queries with its test harness. A **spy** (`vi.fn()`, asserting what
was written) is fine. A **fake** (returns made-up rows) is not.

**PGlite specifics.**

- Each call is an independent database, so there is no truncation step to
  forget.
- Migrations are applied as SQL in filename order, so a hand-typed timestamp
  breaks it immediately.
- The extension funnels every connection into one session, so set pool `max: 1`.
- Note what you give up: hosted-pooler behaviour, and host-specific settings.

**The unit suite is hermetic, and you must prove it.** vitest `env: {}` does
**not** empty `process.env`, so an app env loader reads the developer's
`.env.local` into tests. Skip env loading under `VITEST`, then run the suite
_with_ a real `.env.local` present and check that the secrets are undefined
inside a test.

**With CI local, this matters more.** With no hosted runner, nothing disagrees
with the laptop. So `ci:local` must run each suite in a scrubbed child environment,
spawned with an explicit env and not inheriting the shell's. Add a pattern check
that fails if any test can see a known secret variable. Periodically run
`ci:local` from a fresh clone with no `.env.local` at all.

**Isolation tests pair every refusal with a success.** The other organization
gets `NOT_FOUND`, the owning organization succeeds, and both rows are read back
afterwards. `NOT_FOUND` returned while the update landed anyway is the worst
outcome, and looks identical at the call site.

**Smoke-test the production build early.** Every other tier runs under
`NODE_ENV=test` or `development`, so a `production`-only defect reaches
nothing else. Use a real browser, since the
browser is what enforces cookie rules.

**Record model responses; do not stub them.** A stub returns what someone
imagined. Re-record when a prompt changes. Run evals separately, with a pass
threshold, against the production model before a release.

**Coverage: one gate over a merged run.** Merge unit and integration coverage,
or a module exercised only through a real client reads as barely tested. Keep
floors in one script that both the gate and the published report read. Never
quote the floor in prose, because the copies drift. Verify that your gate can
fail: a per-glob threshold can be silently inert.

**Generated artifacts need deterministic generators.** A gate on a
non-deterministic output fails on noise, and people learn to ignore it.

## Journeys: recorded three times, tested once

Journeys are the unit of QA. Each one is a persona, plus a sequence, plus every
refusal that persona can reach. The journey machinery is the `journeys` module
(`pnpm sdlc add journeys`: the `@ai-sdlc/journeys` package in `tooling/journeys/`),
so a project writes specs, not infrastructure ([registry.md](registry.md)).

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

**An abort before pass 3 leaves the committed evidence as it was.** The learner
copies every journey folder the run can touch, and the index, aside before
pass 1. If the host will not reset, the stack dies, or the run is interrupted,
all of it is restored: screenshots, masks, narratives and `run.json`, not the
masks alone. Once pass 3 has run the result stands, red or green; a red pass 3
keeps its union, because running again is how a mask converges.

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

- **A contended or cold run learns a permanently wrong mask.** A route compiling
  during pass 1, or a slow database pool, makes a step photograph a page that
  has not settled. So:
  - record in **one warm checkout**, one journey at a time, with the routes
    pre-warmed
  - make sure nothing else is recording: the load gate inside `journeys:learn`
    does this as a precondition (exit 75 means held;
    `JOURNEY_LOAD_OVERRIDE="<reason>"` overrides)
  - **discard a contended or abandoned recording** rather than committing it
  - after changing how the stack reaches its database, **relearn from scratch**
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
  `.common.spec.ts` for refusals that depend on nobody. A pattern check verifies the name
  against the persona registry.
- **Indexes are generated from disk.** Never hand-merge a generated table;
  re-run the generator. Playwright's teardown regenerates them after every run
  and **fails the run** if it cannot (`JOURNEY-070`).
- **Once a project has journeys, add `pnpm journeys:index --check` to its
  `ci:local` gate.** It writes nothing, prints a line per generated page, and
  exits 1 when any page differs from what the evidence renders: a hand edit, or
  a re-record whose index was not committed. The generator is deterministic (no
  run durations go into a committed page), which is what makes this a gate rather
  than noise.
- **Capture transports** (email to disk, storage in a local directory) let a
  journey read the sign-in code and download its upload. They are refused on
  every deployment.
- **Ports are derived per checkout**, and the sweep kills only a listener an
  _abandoned_ journey stack of this checkout recorded (see
  [multi-agent.md](multi-agent.md) § _Ports_); it never kills this checkout's
  listeners.
- **Drift detection**: `journeys:drift` maps the routes a PR changed to the
  journeys whose recordings visited them, and requires a re-record or a
  a `No-Rerecord: J<nn> <reason>` commit trailer (one journey per trailer; the reason is required). It cannot see a shared component with no
  route, so nothing reported is not proof that nothing moved.
- **Released to QA by a person.** `/journeys ready-for-qa` adds the sign-off.
  Green says the paths that exist pass; it cannot say the right paths were
  written.

### Storing it

References and masks must be versioned with the code, because a re-record is
reviewed in a PR, and they grow with every re-record, so:

- **Store screenshots, masks and rendered emails in Git LFS**, configured in
  base's `.gitattributes`. Narratives and `run.json` stay as plain git.
- Keep only the **current** reference per step. History lives in git, not in
  extra files.
