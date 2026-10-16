@ai-sdlc/journeys: journey testing — the recorder, the mask core, the QA verdict, the stack host that runs an app through a `StackAdapter`, and the `journeys` CLIs (learn, test, delta, drift, index, timing, stack). See README.md for the layout and configuration; the procedures are the `/journey-*` skills.

Preserved failure modes — each is asserted by a test here; do not weaken one to make a build green:

- **A mask may only grow through a relearn.** It is a union across passes, so a wrong box is permanent. `MAX_STEP_COVERAGE` and `MAX_DECLARED_BOX` are ratchets: raising one needs a written reason beside it, in the same commit.
- **`pixelmatch` needs `diffMask: true`**, or every pixel reads as differing and the learned mask is the whole page.
- **A box path names one element, not a set.** `mergeBoxes` joins boxes sharing a `from` however far apart; a selector or a bare `span` as a path spans the gap between two clocks.
- **One rounding: `boxOf`.** `[floor(left), ceil(right))`, never `floor(left) + ceil(width)`. The census in `dom.test.ts` fails on any other `Math.floor`/`Math.ceil` under `src/`.
- **Declared boxes resolve from a selector, and a comparison never learns.** `refreshDeclared` unions for one comparison and writes nothing; `verifyStored` drops on a learning pass. Opposite answers, both right.
- **A settling region is not volatile.** `classifyMotion` masks only what is still moving when the window closes.
- **A check has three answers.** `unknown` port holders are never killed, a probe timeout is `unreadable` (and discards the pass), a load of 0 is `cannot-ask`, a missing sign-off file releases nothing, a red journey is not QA's whatever the sign-off says.
- **A sweep is for what a previous run of this checkout abandoned.** Attribute before signalling; refuse another checkout's (`JOURNEY-002`) and an unattributable one (`JOURNEY-003`); never sweep inside a Playwright worker or when `JOURNEY_DB_EXTERNAL` is set. Attribution is the nearest ancestor holding the marker, not a path prefix — a worktree lives inside the main checkout.
- **Scratch is swept once per stack, in `host.mts`, at the start** — never in test setup, never at teardown. A second caller deletes pass 1's evidence between passes.
- **An adapter never spawns `detached`.** A detached app survives the runner's group kill, keeps the port and the inherited stdout, and the shell waits for ever. Return the root `pid`; the host kills the tree leaves-first.
- **Ports are pinned into the environment** by the first resolver, so every spawned process inherits one answer.
- **An app port must not equal the control port** (`dbPort + 1`); a readiness probe against the control server gets 404 for ever.
- **Pass 1 matches; it does not learn.** Its baseline is the committed recording, a different build after any UI change. Only pass 2 (same build) learns, and only pass 3 gates. A step that threw learns nothing.
- **A passing comparison writes nothing.** The committed pixels are copied back, so a re-record's diff is exactly the steps that changed. Credit a declared box (`exercised`) _before_ that copy, and write the mask only when a stamp changes.
- **Nothing is deleted before a run.** Each step overwrites its own files; a run that dies early must not eat recordings it never reached.
- **A dead stack learns nothing.** The learner probes the control channel after each learning pass and restores every mask from before pass 1 when it is not `up`.
- **The verdict markers live in `README.md`**, from one constant (`FAILED_MARKER`, `CHANGED_MARKER`) that every writer and reader imports. Moved to `diff.md`, every path would read green.
- **A wait, never a mask, for a page still arriving.** `settle.selectors` are presence-guarded and so must run after the `aria-busy` wait, or a skeleton makes them vacuous.
- **The delta report and its images live under `reportRoot`, outside the evidence root**, which every census enumerates.
- **Selection is by spec path, never by `--grep`**, and a selector that matches nothing throws rather than widening to the whole suite.
- **Every recording carries the persona level**, marked by `persona.json`, never by a name or an absence.
- Files run under plain `node`: erasable TypeScript only, no constructor parameter properties, relative imports with `.mts`, `import type` for types. Only `recorder/`, `render/` and `playwright/` import `@playwright/test` at runtime; config, CLIs and censuses must not.
