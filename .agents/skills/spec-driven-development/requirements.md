# Requirements: the checklist and the checks

Used by `spec-driven-development` for one change, and by `/kickoff` for the
whole product. The bar: an agent with only `docs/requirements/`, the project
brief and the ADRs can build the feature without asking a question. Every
gap that would make it ask is a finding.

## What lives where

```
docs/requirements/
  sources/          imported documents, verbatim, never edited (pnpm sources:add)
  brd.md            why, for whom, success, scope, rules, constraints, risks
  prd.md            feature index (IDs · personas · phase · depends), non-functional requirements, release slices, ## AI
  personas.md       @slug personas
  access-model.md   tenancy (`Tenancy: <model>`), roles × capabilities, row scope, shells
  domain-model.md   entities, relationships, lifecycles
  ux.md, ux/        the design brief and prototype references
  technology.md     every technology trigger, and the ADR deciding it
  features/F<nn>-<slug>.md   requirements F<nn>-R<nn>, each with testable acceptance
  journeys.md       journeys (below)
  glossary.md       one word per concept
  review.md         findings, assumptions, and the verdict line
```

IDs are never renumbered or reused. A dropped requirement is marked `withdrawn`.

## Journeys

A journey is how a feature becomes worth something to someone. Projects with
personas use three levels:

```markdown
## J12 — A workshop runs from booking to payout

### J12.1 — @organizer publishes the workshop

1. Creates a draft with a date and a capacity (F03-R01)
2. Publishes it; it appears in the public list (F03-R02, F05-R01)

### J12.2 — @attendee books a seat

Persona: @attendee

1. Finds the workshop and books (F04-R01)
2. Is refused when it is full, and offered the waitlist (F04-R03)
```

- **`J<nn>`**: the journey. It may span personas: it is the outcome the
  business wants, end to end.
- **`J<nn>.<n>`**: one persona's part of it (a `Persona:` field, or the
  `@slug` in its heading). Exactly one persona.
- **Tasks**: the list items within a persona's journey, each citing the
  requirements it exercises.

A single-persona journey may skip the middle level: `## J07 — @admin …` with
its tasks directly under it. `pnpm plan:check` holds both forms to the same
rules: every persona-level journey names one persona, every task cites a
requirement, every requirement is served by a task, every persona walks a
journey. Plan items cite the journeys they complete (`journeys: [J12.2]`), and
a milestone completes whole `J<nn>` journeys.

## The checklist, per feature

- **who**: the personas (an actor not in `personas.md` is a finding)
- **outcome**: what they can do afterwards; done means Given / When / Then
- **trigger and preconditions**
- **main flow and every refusal**: bad input, no permission, conflicting
  state, third-party failure; each with its message or behaviour
- **data**: entities, required and optional fields, visibility per tenant and
  role, retention
- **lifecycle**: states, transitions, and who sends each event
- **screens**: the pattern from the design brief, its shell, and the loading,
  empty and error states
- **notifications**: who, which channel, what consent
- **security**: the asset, the attacker, what stops them
- **observability**: what proves it works in production
- **AI**: can AI act, propose, assist, see or notice here (`docs/kit/ai.md`)?
  If so, its mode, data class, authority, eval and cost cap; if not, why not
- **technology**: does it need a decision not yet made?
- **non-functional**: performance, accessibility, audit, time zones, money
- **its journey tasks**

## The checks a spec must pass

**Completeness.** Every persona walks a journey, every task cites a
requirement, every requirement serves a task. Every refusal agrees with
`access-model.md`. Every entity named is in `domain-model.md`, and every
lifecycle event has a sender.

**Correctness.** No contradictions between documents, the brief and the ADRs.
No hidden decision (a vendor, policy or number picked silently). Vendor claims
checked against current docs. One word per concept (fix the glossary).

**Implementability.** It is not implementable when an acceptance criterion is
not testable, a refusal has no behaviour, a screen has no pattern or no empty,
loading or error state, a field's type or visibility is unknown where it
matters, an integration has no decided vendor, or a rule says "as
appropriate".

Each failure is a finding in `review.md` with a recommended answer, or a `Q-`
file with `blocks:`. Never fill a gap with a plausible guess: it reads exactly
like a decision. `review.md` ends with one line `pnpm plan:check` reads:

```
Verdict: ready-to-plan | ready-with-assumptions | ready-pending-decisions | not-ready
```

Then run `pnpm plan:check --stage requirements`.
