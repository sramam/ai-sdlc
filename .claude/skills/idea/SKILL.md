---
name: idea
description: Discovery — turns an idea into requirements an agent can build from without asking. Builds the BRD and PRD from a conversation, or imports and vets existing documents; discovers personas, tenancy and access, the domain model and the design brief; surfaces every technology the requirements imply. One of three skills allowed to write docs/requirements/. Restartable and non-destructive.
---

# Idea

_What_ we are building is decided here. _How_ we build it is `/kickoff`'s job.
After discovery, new requirements come in through `/add-requirement`.

**The bar:** when `/idea` is done, an agent with only `docs/requirements/`, the
project brief and the ADRs can implement the whole MVP **without asking a
question**. Every gap that would make it ask is a finding here.

## Writing to `docs/requirements/`

`docs/requirements/` is locked: a hook refuses edits there unless one of
`/kickoff`, `/idea` or `/add-requirement` is running. On start, this skill
claims the lock for its session:

```bash
echo "$CLAUDE_CODE_SESSION_ID idea" > .claude/requirements-session
```

It releases the lock on finish (`rm .claude/requirements-session`). Each commit
touching `docs/requirements/` carries a `Requirements: idea` trailer, which the
`commit-msg` hook requires. Source documents (an imported BRD or a client spec)
live in `docs/requirements/sources/` and are **never** edited, even under the lock.

## Modes

| invocation                | when                                                    | does                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/idea`                   | there is no product definition yet, or it is incomplete | **conversation**: builds the BRD, then the PRD, one theme at a time; resumes where it stopped                                                                                           |
| `/idea <path>`            | a BRD, PRD, spec or brief exists                        | **import and vet**: copies it into `sources/`, restructures it into the requirements with IDs, then checks completeness, correctness and implementability, and converses about the gaps |
| `/idea status`            | any time                                                | what is decided, provisional or open, per section, and the current verdict (recomputed after kickoff's second pass). **Asks nothing and writes nothing**                                |
| `/idea check [F<nn>…]`    | before planning or building a feature                   | runs the **implementability pass** on the named features (or all of them) and updates the findings in `review.md`                                                                       |
| `/idea revisit <section>` | a decision needs to change                              | reopens it, keeping the old answer struck through, with the date and reason                                                                                                             |

## What it produces

```
docs/requirements/
  sources/          imported documents, verbatim, never edited
  brd.md            business: why, for whom, success, scope, rules, constraints, risks
  prd.md            product: overview, feature index (IDs · personas · phase), non-functional requirements, release slices
  personas.md       discovered personas (@slug)
  access-model.md   discovered tenancy, membership, roles × capabilities, row scope
  domain-model.md   high-level objects, relationships, lifecycles, ER diagram
  ux.md             the design brief, plus prototype references in ux/ (Lovable, Figma)
  ux/               screenshots and notes of the chosen prototype direction
  technology.md     every technology trigger found, and the ADR deciding it
  features/F<nn>-<slug>.md   IDed requirements with testable acceptance
  journeys.md       J<nn>: one persona, steps citing requirement IDs
  glossary.md       one word per concept
  review.md         findings, assumptions, and the readiness verdict
docs/plan/questions/Q-*.md   everything still open
```

The structure and ID rules are in `docs/kit/plan-and-requirements.md`.

**`/idea` recommends; `/kickoff` decides.** Technology triggers, the
authorization engine and the backoffice split are **recorded** here in
`technology.md` (the need, its requirement IDs, the candidate options and a
recommendation), and **decided** in kickoff's second pass. That is why the
verdict may read _ready, pending decisions_ until kickoff has run.

---

## Conversation mode

### How to hold the conversation

- **Open wide, then narrow.** "Tell me about it: who is it for, and what is
  broken for them today?" Let the author talk, then **reflect back** a short
  summary and ask what you got wrong.
- **One theme at a time**, with questions in batches, each with options and a
  recommendation. Use AskUserQuestion for choices, and free text for stories.
- **Draft early and show it.** People correct a draft far better than they
  answer an abstract question.
- **Keep the author's words** where they state intent.
- **Never invent.** A gap is marked `provisional` with a `Q-` file. A plausible
  filler reads exactly like a decision.
- **Push back** on contradictions, naming both statements, and on scope creep
  disguised as MVP.

### BRD themes, in order

1. **Problem and why now**: who hurts, how, what they do today, and what it costs.
2. **People**: **persona discovery** (`docs/kit/plan-and-requirements.md`).
3. **Goals and success**: measurable outcomes with dates, and **how each will be
   measured** (a metric, a span, an analytics event).
4. **Scope**: MVP in and out, the deadline, and what comes later.
5. **Tenancy and access**: **tenancy discovery**. **Blocking** for the data model.
6. **Business rules and policies**, each with its source.
7. **Data and threats**: personal data, retention, compliance, regions, audit; the
   assets and adversaries (`docs/kit/security.md`); data that must never reach a model,
   an intermediary or a rented GPU.
8. **Money and time**, if relevant.
9. **Constraints and assumptions**: budget, platforms, integrations that must be
   used or avoided.
10. **Risks**: what could sink it, and the experiment that retires each one.
11. **AI, deeply integrated**: ask every question in `docs/kit/ai.md` § _What `/idea`
    asks_, per persona and journey. Can AI **do** the work (act, or propose for
    approval), **assist** (draft, extract, classify, explain), **see** (plain
    language over dashboards and BI, self-explaining anomalies), or **notice**
    (proactive flags)? Does the product need per-customer setup, and so
    **AI-prompted onboarding**? Record a "no" with its reason where AI does not
    earn its place.
12. **Shells, roles and the backoffice**: does each persona get its own
    **shell** (home, navigation, the areas it may reach)? Can one person hold
    several roles (an admin in one tenant, a member in another, a customer and a
    staff member), and how do they **switch** between them? Who works in the
    **backoffice** (operators, support, admins of the product itself), and how
    separate must it be from the customer-facing front: same app with its own
    shell, or a separate app? Record the need and the candidates; kickoff decides.
    See `docs/kit/ux.md` § _Shells and role switching_.

### PRD, derived and then confirmed

1. **Features**: cluster the capabilities into `F<nn>`. Let the author merge,
   split and rename.
2. **Journeys**: for each persona, the end-to-end sequences (`J<nn>`).
3. **Requirements**: the **full checklist** on each feature, giving
   `F<nn>-R<nn>` with testable acceptance.
4. **Access model**: the persona × capability table, consistent with every
   refusal. **Record** a recommendation of Oso or SpiceDB in `technology.md`,
   with the criteria in `docs/kit/security.md`. Kickoff decides.
5. **Domain model**: per `docs/kit/data-model.md` § _Discovering it_. Use the ER diagram
   and walk every journey across it. High level only.
6. **Design brief**: ask the UX questions in `docs/kit/ux.md`, and write
   `docs/requirements/ux.md`. Then **prototype with Lovable**. Lovable has no
   CLI, so the work is split:
   - **the agent** writes the prompt for the effortless tasks from the brief to
     `docs/requirements/ux/lovable-prompt.md`
   - **the person** runs it in Lovable, iterates, and drops screenshots of the
     chosen screens into `docs/requirements/ux/`
   - **the agent** writes the notes on what to keep, and references the
     screenshots from the design brief

   No Lovable account yet? That is a `Q-`, not a blocker; the brief stands on
   its own. Use Figma when the brand, a custom visual or a design handoff calls
   for it (`docs/kit/ux.md` § _Design partners_).

7. **AI capabilities**: write the `## AI` section of `prd.md`, listing each AI
   capability with its mode (act, propose, assist, see, notice, set up), its
   data class, its eval and its cost cap. Add the AI paths to the journeys,
   including approving, correcting and undoing.
8. **Shells**: in `access-model.md`, list each shell, the personas and roles
   that land in it, the role-switching rules, and whether the backoffice is
   separated (or the candidates, until kickoff decides). In
   `docs/requirements/ux.md`, give each shell's home and navigation.
9. **Technology triggers**: scan every requirement against
   `docs/kit/technology-decisions.md`. For each trigger the settled stack does
   not cover, **record** it in `technology.md`: the need, the requirement IDs,
   the volumes, the data class and the candidate options. Kickoff runs the
   dialog and the user decides. A trigger nobody has decided blocks only the
   items that need it.
10. **Non-functional requirements and release slices** go into `prd.md`.
11. Run the **three passes** below, then `pnpm plan:check --stage requirements`.

---

## The three passes (conversation and vet modes)

**Completeness**

- every persona has a journey, every journey step cites a requirement, and every
  requirement serves a journey
- every refusal agrees with `access-model.md`
- every entity named in a requirement is in `domain-model.md`, and every
  lifecycle event has a sender

**Correctness**

- contradictions between sections, documents, the project brief and the ADRs
- impossible or unsafe requirements; vendor claims **checked against current
  docs**
- hidden decisions: a vendor, policy or number picked silently
- unsourced or inconsistent numbers; synonyms and homonyms (fix the glossary)

**Implementability.** For each feature, ask: _could an agent build this from the
documents alone?_ It cannot when:

- an acceptance criterion is not testable, or a refusal has no message or behaviour
- a screen has no pattern from the design brief, or no empty, loading or error behaviour
- a field's type, constraint or visibility is unknown where the requirement
  depends on it
- an integration has no decided vendor, or a technology trigger has no decision.
  Before kickoff's second pass, this reads _pending decision_ rather than _not
  ready_
- a rule cites "the usual" or "as appropriate"

Each failure becomes a finding with a recommended answer.

`review.md` ends with a verdict: **ready to plan**, **ready with assumptions**
(each assumption listed, with how cheap it is to reverse), **ready, pending
decisions** (only kickoff's decisions are outstanding), or **not ready**.

---

## The full checklist (per feature)

- **who**: the persona. An actor not in `personas.md` is a finding
- **outcome**: what they can do afterwards; **done means**: Given / When / Then
- trigger and preconditions
- main flow and **every refusal**: bad input, no permission, conflicting state,
  third-party failure
- **data**: entities, required vs optional fields, visibility per tenant and role,
  retention
- **lifecycle**: states, transitions, and who sends each event
- **screens**: the pattern, the four states, whether it is an effortless task
- notifications: who, which channel, what consent
- **security**: the asset, the attacker, what stops them (a `Security:` line)
- **observability**: what proves it works in production
- **AI**: how could AI act, propose, assist, see, notice or set up in this
  feature (`docs/kit/ai.md`)?
  If it does: the mode, the data class and allowed routes, the tool authority,
  approval for consequential actions, the eval and the cost cap. If not, say why
- **shell**: which shell or shells this appears in
- **technology**: does it trigger a decision not yet made?
- non-functional: performance, accessibility, audit, time zones, money
- its journey

## Restartable and non-destructive

- Each section and file carries a marker
  (`<!-- idea: section=scope state=decided updated=… -->`).
- A re-run asks **only** what is `open` or `partial`, plus overdue deferrals and
  answers that arrived in `Q-` files.
- It writes in place, one answer at a time. A hand edit by the author wins.
- A decided answer changes only through `revisit`, with history kept.
- IDs are never renumbered or reused. A dropped requirement is marked `withdrawn`.

## Never wait idle

Unanswered questions become `Q-` files, with options, a recommendation and
`blocks:`. Continue with everything that does not depend on them.

## Done when

- Every BRD theme and PRD file is decided, provisional with a `Q-`, or out of scope.
- Tenancy is not `open`, and every technology trigger is recorded.
- The verdict is **ready, pending decisions** or better.
- `plan:check --stage requirements` passes, and a second `/idea` asks nothing
  new.
- Print the next step: `/kickoff` (its second pass).
