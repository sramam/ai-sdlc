# Journey add

**Checklist (read this first; details follow):**

1. Find the journey in `docs/requirements/journeys.md`. Not there → stop: a new journey is a
   requirement, so it goes through `/spec` first.
2. Decide it is a journey, not a story or a screen (table below).
3. Add `{ id, title, personas }` to `registry.journeys` in `journeys.config.mts`; add any new
   persona to `registry.personas` with its label.
4. `pnpm journeys:index`: loading the config validates the registry (a duplicate id or an
   undeclared persona is refused, naming it), and the journey appears under Not started.
5. Report (below), then print `/journeys test <id>` as the next command.

**Two skills, and the split is description versus validation.** This one makes a described
journey recordable; `/journeys test` records the product doing it. A recording of a journey nobody
described is a transcript, and writing both at once checks nothing.

## Is it a journey at all?

|                      |                                                                       |
| -------------------- | --------------------------------------------------------------------- |
| a journey            | a sequence a person performs, end to end, that leaves them better off |
| a story              | a unit of delivery (a plan item), not a journey                       |
| a screen             | part of a journey, never one                                          |
| platform work (`X-`) | no persona, nothing to walk; never a journey, never QA's              |

The test is whether somebody can be _done_. A second route to an outcome is its own journey:
importing by spreadsheet and by typing share nothing but the result.

## The registry entry

```ts
// journeys.config.mts
registry: {
  journeys: [{ id: "J12", title: "Cancelling a session", personas: ["organizer"] }],
  personas: { organizer: { label: "An organizer, running their own events" } },
},
```

|            |                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | the `J<nn>` from `journeys.md`. Never invent or renumber one: ids are append-only and every recording, plan item and sign-off names them                                                    |
| `title`    | exactly as the recordings will be foldered: `<id>-<slug(title)>`. The recorder throws on a second spelling, because a renamed title writes a second folder and the old one reads as current |
| `personas` | the `@slug`s from `journeys.md`, without the `@`. Who may walk it, not who has. `common` needs no entry: any journey may record a walk that depends on nobody                               |

Renaming a journey later is a deliberate act: rename the folder under the evidence root in the same
commit, or the directory pattern check names the old one.

## What this skill must not do

- **Write `docs/requirements/`.** That is `/kickoff` and `/spec`.
- **Write a spec or record anything.** That is `/journeys test`.
- **Add a line to `ready-for-qa.md`.** A journey with no recording is not QA's, and a person
  releases one anyway (`/journeys ready-for-qa`).

## Reporting

1. what somebody is trying to do, in their words: the sentence that made this a journey
2. where it is described (`journeys.md`, and the requirement IDs its steps cite)
3. whether it is a new outcome or another route to an existing one
4. the personas registered, and any persona added
5. what is unknown: a step you would have to guess at, which `/journeys test` will otherwise discover

Then stop. `journeys index` lists it under Not started, which is the correct state: described,
not validated. Next: `/journeys test <id>`.
