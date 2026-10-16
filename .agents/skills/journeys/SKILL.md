---
name: journeys
description: Journey testing (module) — turns a journey from docs/requirements/journeys.md into recorded, reviewable evidence that the product does it end to end, per persona. `/journeys add <id>` registers it, `/journeys test <id>` records it (screenshots, narrative, captures per step), and `/journeys ready-for-qa <id>` releases it once a person has decided it is worth a tester's time. Use when a journey's items have landed, when a change touches a recorded journey, or when asked for evidence that something works.
---

# Journeys

A journey (`J<nn>`, and its persona journeys `J<nn>.<n>`) is how this project
measures delivered value: a feature is done for someone only when the journey
it serves runs end to end. This skill makes that observable. It complements
`browser-testing-with-devtools`, which is for exploring and debugging; this is
the recorded evidence a person reviews.

| invocation                    | does                                                                                        | procedure                          |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `/journeys add <id>`          | registers a described journey so it can be recorded; writes no spec, records nothing        | [add.md](add.md)                   |
| `/journeys test <id>`         | records it, learns its masks in three passes, drives the diffs to one readable review       | [test.md](test.md)                 |
| `/journeys ready-for-qa <id>` | releases a green, recorded journey to QA, **only once a person has decided it is worth it** | [ready-for-qa.md](ready-for-qa.md) |

In the pipeline: `/build` runs `add` and `test` for a journey when the last
item it depends on lands, so the evidence arrives with the work. `ready-for-qa`
is never the agent's own decision.

The machinery is `tooling/journeys` (its README); the strategy is
`docs/kit/testing.md` § _Journeys_.
