---
name: journey-test
description: Record a journey end to end as reviewable evidence — a screenshot, narrative and captures per step, per path — learn its masks in three passes, and drive the diffs to a state a person can approve in one read. Use when adding or re-recording a journey under the evidence root (docs/journeys/).
---

# Journey test

**Checklist (read this first; details follow):**

1. The journey is in the registry (`journeys.config.mts`). Not there → `/journey-add` first.
2. It can actually be performed, and the seed produces its starting state. If not, that is the
   finding — fix the seed or report; never a private fixture.
3. One spec per walk: `e2e/<id>-<slug>.<persona>.spec.ts`; `test.beforeAll(resetJourneyStack)` first.
4. Every refusal the persona can reach is a path, beside the happy one.
5. Record in **one warm checkout, one journey at a time**: `pnpm journeys:learn --journey J<n> --persona <p>`.
6. Fix a broken spec with a **single** run (`pnpm journeys:test …`), not three passes.
7. Read the delta report; nothing spurious, every step held. Discard a contended run.
8. Run the census; commit recordings and masks with the change that moved them.
9. Report (below). Releasing to QA is `/journey-ready-for-qa`, and a person's call.

The machinery is `tooling/journeys` (README there); the strategy is `docs/kit/testing.md § Journeys`.

## Writing the spec

```ts
import { expect, resetJourneyStack, test } from "../tooling/journeys/src/playwright/fixtures.mts";
import { Journey } from "../tooling/journeys/src/recorder/journey.mts";

test.beforeAll(resetJourneyStack);

test.describe("J12 Cancelling a session", () => {
  test("happy", async ({ page }) => {
    const journey = await Journey.open(page, {
      id: "J12",
      title: "Cancelling a session",
      path: "happy",
      intent: "cancel a session and have attendees told",
      persona: "organizer",
    });
    await journey.step("Open the session", "The organizer finds it on their list.", async () => {
      await page.goto("/sessions");
      await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    });
  });
});
```

- **A step asserts.** `step(title, note, act)` — `act` performs the interaction _and_ asserts the
  outcome. A step with no assertion records a claim nobody checked.
- **The title is the registry's**, exactly; the recorder throws on a second spelling.
- **The persona is in the filename and in every `Journey.open`**, and they agree — the census
  checks. `common` is for a walk that depends on nobody (a wrong code, an expired link), and is a
  declaration: do not file an undecided walk there.
- **Captures**: `Journey.capture(label, text)` for page text; `Journey.rendered(label, html)` for an
  email (read it with `lastCaptured(to, /subject/)` from `outbox.mts` — never re-render the
  template); `Journey.file(label, name, bytes)` for a document (a PDF is rendered page by page and
  gated; needs `pdfjs-dist`); `Journey.image(label, png)` for a computed image. All are gated.
- **A walk's page**: in `test.afterAll`, `writeJourneyPage({ … })` from `recorder/journey-page.mts` —
  summary, flow (mermaid, naming every path), promises, paths, **byHand** (what no recording
  reaches, and why), implementation notes.
- **Page errors fail the recording.** Declare a known, harmless one with
  `allowPageError(page, /pattern/, "why")` — a reason about the mechanism, never "it was failing".

## Recording: three passes, and only the third gates

`pnpm journeys:learn --journey J12 --persona organizer` starts one stack and runs the walk three times:

| pass        |                                                           | contract                                                                       |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1. match    | against the committed reference, under the committed mask | a matching step keeps the committed image; a changed one becomes the reference |
| 2. discover | same build again                                          | what differs between two runs of identical code joins the mask                 |
| 3. verify   | masks applied                                             | the only pass that proves anything; red exits 1                                |

Then it runs the census (every step has a mask; learned boxes under `MAX_STEP_COVERAGE`, no
declared box over `MAX_DECLARED_BOX`; no mask from an older rule) and writes the delta report to
`test-results/journey-reports/delta.md`.

- **Select with `--journey`/`--persona`, never `--grep`**: `J2` is a prefix of `J23`, and a
  learning pass on a walk nobody is reviewing grows its masks.
- **A red pass 1 or 2 still learns** the steps before the break — but fix the spec with one
  `pnpm journeys:test --journey J12 --persona organizer` run; three passes to find one locator is
  the expensive way round.
- **`--relearn`** starts every mask from nothing. Use it when the reason a box was learned has gone
  (an animation now frozen, a race now waited for) — the union otherwise keeps it for ever.

## The conditions that keep masks honest

- **One warm checkout.** A cold route compiles during pass 1, a step photographs a page that has
  not arrived, and the mask learns it **permanently** — a union only grows. Recording in parallel
  checkouts is slower, not faster.
- **The recording lock is inside the command.** `journeys learn` refuses (exit 75, nothing touched)
  while another checkout is recording or load is over `cores + 2`. Wait, or set
  `JOURNEY_LOAD_OVERRIDE="<reason>"` — the reason is printed into the run. Do not check `uptime`
  and then start: a check followed by an action is a race.
- **Discard a contended or abandoned run.** If two recordings overlapped, or you stopped one, throw
  its output away (`git restore docs/journeys`) and record again. Partial evidence from a contended
  run looks exactly like progress. Stop a run by its PID in your own checkout — never `pkill -f`,
  which reaches into every worktree.
- **A dead stack learns nothing** — the learner puts every mask back and says so. Restore the
  screenshots with `git restore` before relearning.
- **After changing how the stack reaches its data, relearn from scratch** (`--relearn`). A slow or
  contended data path makes pages arrive late, and every mask learned over it is suspect.

## When a mask goes wrong

| the run says                                            | the answer                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| _the page was still changing while it was photographed_ | a wait: add a `settle.selectors` entry in `journeys.config.mts` for the region. **Never a mask** — a settling region is refused by design |
| _renders a date that nothing masks_                     | `data-volatile-date` on the render site; or `mask: [locator]` on the step if the **journey** typed the date                               |
| _a volatile value whose width moves other elements_     | render it at a fixed width; no mask can cover pixels elsewhere on the page                                                                |
| _N step(s) hide more than 3%_                           | open the `-mask.png`; the two learning passes and their diff are under `test-results/mask-evidence/`                                      |
| _a declared box wider than 1%_                          | the attribute is on the row, not the value                                                                                                |

## Read the delta before committing

`test-results/journey-reports/delta.md`: per journey, identical / changed / resized / added /
**spurious**, and for each moved step the old and new reference, both masks, and the diff under the
new mask, with pass 3's verdict.

- **A mask may only grow where its screenshot changed.** A spurious row fails the run; restore the
  committed mask (the report prints the command).
- **Judge a changed row by where it moved, not by how much.** A moved edge and a renamed label both
  land near 0.2%.
- _Not the new standard_ at the top means a step did not hold — do not commit it.

## Before committing

```bash
pnpm exec vitest run e2e/journeys.census.test.ts   # the project's census, over tooling/journeys/src/census
```

The census names orphaned screenshots (a renamed step leaves its old image behind, and git shows
additions with no deletions — which is what correct work looks like too), folders from a renamed
journey, paths with no persona level, and specs whose name disagrees with what they record. Stage
by path. Recordings, masks and the walk's page go in the same commit as the change that moved them.

## Reporting

- every path recorded, and whether each is green
- every screenshot that **changed**, with your judgement of which side is right
- masks that grew, and why that growth is real
- what is not automated (`byHand`), and anything you found the product cannot do

Going green does not release a journey. Next: a person decides, then `/journey-ready-for-qa`.
