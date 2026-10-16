# @ai-sdlc/journeys

Journey testing: recording what a person does in the product as reviewable evidence — a screenshot per step, a narrative, the emails and documents it produced — and comparing later runs against it with the volatile regions masked out. Each part below was paid for; the comments in the source say what each cost.

The project's own: it arrives with `pnpm sdlc add journeys`, and is changed here when the project needs it. `pnpm sdlc diff journeys` shows what changed upstream; `pnpm sdlc update journeys` takes it without overwriting a local edit (docs/kit/registry.md).

## Commands

`journeys <command>` (`src/cli/journeys.mts`, the package `bin`) runs each as its own `node …/cli/<name>.mts` process, so the load gate can see a recording by its command line.

| command  | does                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `learn`  | three passes over one stack — match, discover, verify — and only the third gates; load gate first (exit 75 = held), stack probed after each learning pass, mask pattern check, then `delta --report` |
| `test`   | one comparison pass; never learns, never writes a mask or a reference                                                                                                                                |
| `delta`  | what a re-record changed against a ref; **a mask may only grow where its screenshot changed** (spurious → exit 1); `--report` writes `<reportRoot>/delta.md` with old/new images                     |
| `drift`  | which journeys' recordings visited a route a changed file renders; exit 1 unless re-recorded or excused by a `No-Rerecord: J<n> <reason>` commit trailer                                             |
| `index`  | regenerate `<evidence>/README.md`, each journey's pointer page and each walk's status line, from disk                                                                                                |
| `timing` | re-record journeys one at a time when the machine is quiet, measuring each; one delta for the batch                                                                                                  |
| `stack`  | run the app (the configured `StackAdapter`) until signalled — Playwright's `webServer`, and the learner's child                                                                                      |

`--journey J4 --persona organizer` selects spec **files** by name (`e2e/j4-<slug>.organizer.spec.ts`); prefer it to `--grep`, since `J2` is a prefix of `J23`.

## Layout

| module                                                 | holds                                                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/recorder/journey.mts`                             | `Journey`: `open`, `step`, captures (`capture`, `rendered`, `file`, `image`); every step compared under its mask and written after every step; `run.json` |
| `src/recorder/settle.mts`, `settle-config.mts`         | waiting for a page to arrive: `aria-busy` by default, project `settle.selectors`, the scroll container, hidden framework chrome, the mutation watch       |
| `src/recorder/evidence.mts`                            | the narrative and `diff.md` as pure functions; the verdict markers every reader shares; `run.json`; the persona marker                                    |
| `src/recorder/journey-page.mts`                        | a walk's own page (`writeJourneyPage`): summary, flow, promises, paths, by-hand, notes                                                                    |
| `src/render/pdf.mts`                                   | a PDF rendered per page in the browser, its text and date boxes; `pdfjs-dist` is an optional peer resolved from the project                               |
| `src/outbox.mts`                                       | the capture contract: `$JOURNEY_OUTBOX_DIR/index.jsonl`, lines of `{to, subject, htmlPath, textPath, attachments?}`; readers and `appendCaptured`         |
| `src/playwright/`                                      | `defineJourneyPlaywrightConfig`; the `test` fixtures (client IP per test, page-error guard, `allowPageError`, `resetJourneyStack`); global setup/teardown |
| `src/registry.mts`                                     | journeys and personas from the config; `assertTitle`, `assertPersona`, `journeyFolder`                                                                    |
| `src/routes/`                                          | `RouteAdapter`: `tanstack` (default) and `next-app`; `under`                                                                                              |
| `src/pattern-check/pattern-check.mts`                  | snapshot, directory, persona, spec and isolation pattern checks, as functions returning findings                                                          |
| `src/delta/`, `src/drift/`, `src/index/`, `src/learn/` | the libraries behind the CLIs                                                                                                                             |
| `src/mask/`, `src/stack/`, `src/verdict.mts`           | the mask core, the stack host and the QA verdict (see `agents.md`)                                                                                        |

Only `src/recorder`, `src/render` and `src/playwright` load Playwright, so the CLIs and the pattern checks run under plain `node` and vitest.

## Configuration

`journeys.config.mts` at the repository root, default export; every field is optional and a list replaces its default:

```ts
import { defineJourneysConfig } from "./tooling/journeys/src/config.mts";

export default defineJourneysConfig({
  adapter: "e2e/stack.mts", // default export: StackAdapter; optional named `seed`: SeedAdapter
  registry: {
    journeys: [{ id: "J4", title: "Signing In", personas: ["organizer"] }],
    personas: { organizer: { label: "An organizer" } },
  },
  // registryFile: "e2e/journeys.registry.mts",
  settle: { selectors: [{ selector: "[data-avatar]", until: "non-empty" }] }, // see EXAMPLE_SETTLE
  routes: { kind: "tanstack", dir: "src/routes" }, // or { kind: "next-app", dir: "app" }, or { module }
  evidenceRoot: "docs/journeys", // under LFS per .gitattributes
  scratchRoot: "test-results",
  reportRoot: "test-results/journey-reports", // kept by the scratch sweep
  specDir: "e2e",
  playwrightConfig: "playwright.config.ts",
  driftBase: "origin/dev",
  pdfjsFrom: ["apps/web"],
});
```

```ts
// playwright.config.ts
import { defineJourneyPlaywrightConfig } from "./tooling/journeys/src/playwright/config.mts";
import journeys from "./journeys.config.mts";
export default defineJourneyPlaywrightConfig({ journeys, root: import.meta.dirname });
```

A file rather than a `journeys` key in `sdlc.config.json`, because that type lives in `tooling/core`.

## Evidence layout

```
<evidenceRoot>/README.md                       generated index
<evidenceRoot>/ready-for-qa.md                 the one hand-written file: a person's sign-offs
<evidenceRoot>/<id>-<slug>/README.md           pointer: one row per walk
<evidenceRoot>/<id>-<slug>/<persona>/          persona.json, README.md (the walk's page)
<evidenceRoot>/<id>-<slug>/<persona>/<path>/   README.md, diff.md, run.json, snapshots/, files/
```

Every recording carries the persona level; `common` is the walk that depends on nobody.

## Platform

POSIX. Port attribution uses `lsof`, teardown uses `pgrep -P`, the load gate uses `pgrep -f`. Without them, ports read free or unattributable (and are never killed) and the load gate allows; binding a port is Node's own check and works everywhere.
