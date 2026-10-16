# Kickoff stage 2: the product

_What_ we are building. The bar: when this stage is done, an agent with only
`docs/requirements/`, the project brief and the ADRs can implement the whole
MVP without asking a question. Every gap that would make it ask is a
finding.

**Checklist:**

1. The requirements lock is kickoff's (claimed in `SKILL.md`).
2. Conversation, or import: a BRD, PRD, spec or brief the author already has.
3. Ask only what is open; one theme at a time; draft and show each section.
4. BRD themes 1–12, then PRD steps 1–11, in order.
5. Record the decisions it implies (technology, authorization engine,
   backoffice) in `technology.md`; stage 3 decides them.
6. Run the checks in `spec-driven-development`'s
   [requirements.md](../spec-driven-development/requirements.md) and write
   `Verdict:` in `review.md`; `pnpm plan:check --stage requirements` passes.

What lives where, and the journey levels, are in that same file. Source
documents live in `docs/requirements/sources/` and are never edited.

**Importing a document**: create it under `docs/requirements/sources/` with
`Write` (the lock allows creating a new file there, never changing one), run
`pnpm sources:add <path>` to record its hash in `sources/MANIFEST`, and commit
with `Requirements: kickoff`. `ci:local` refuses a source whose hash has
changed. Then restructure it into the requirements with IDs at Level 2 of
`agent-review`: two agents extract blind from the source, a third reconciles
every difference against it, and the control total is the source's own
counts (its requirements, personas, screens), so nothing is dropped or
invented in the restructuring. Run the checks, and converse about the gaps.

**Stage 2 recommends; stage 3 decides.** Technology triggers, the
authorization engine and the backoffice split are recorded in
`technology.md` (the need, its requirement IDs, the candidate options and a
recommendation). That is why the verdict may read `ready-pending-decisions`
until stage 3 has run.

## Conversation mode

### How to hold the conversation

- **Open wide, then narrow.** "Tell me about it: who is it for, and what is
  broken for them today?" Let the author talk, then reflect back a short
  summary and ask what you got wrong.
- **One theme at a time**, with questions in batches, each with options and a
  recommendation. Use AskUserQuestion for choices, and free text for stories.
- **Draft early and show it.** People correct a draft far better than they
  answer an abstract question.
- Keep the author's words where they state intent.
- **Never invent.** A gap is marked `provisional` with a `Q-` file. A plausible
  filler reads exactly like a decision.
- Push back on contradictions, naming both statements, and on scope creep
  disguised as MVP.

### BRD themes, in order

1. **Problem and why now**: who hurts, how, what they do today, and what it costs.
2. **People**: persona discovery ([discovery.md](discovery.md) § _Personas_).
3. **Goals and success**: measurable outcomes with dates, and how each will be
   measured (a metric, a span, an analytics event).
4. **Scope**: MVP in and out, the deadline, and what comes later.
5. **Tenancy and access**: tenancy discovery ([discovery.md](discovery.md)
   § _Tenancy_). Blocking for the data model.
6. **Business rules and policies**, each with its source.
7. **Data and threats**: personal data, retention, compliance, regions, audit; the
   assets and adversaries (`docs/kit/security.md`); data that must never reach a model,
   an intermediary or a rented GPU.
8. **Money and time**, if relevant.
9. **Constraints and assumptions**: budget, platforms, integrations that must be
   used or avoided.
10. **Risks**: what could sink it, and the experiment that retires each one.
11. **AI, deeply integrated**: ask every question in `docs/kit/ai.md` § _What kickoff
    asks_, per persona and journey. Can AI do the work (act, or propose for
    approval), assist (draft, extract, classify, explain), see (plain
    language over dashboards and BI, self-explaining anomalies), or notice
    (proactive flags)? Does the product need per-customer setup, and so
    AI-prompted onboarding? Record a "no" with its reason where AI does not
    earn its place.
12. **Shells, roles and the backoffice**: does each persona get its own
    shell (home, navigation, the areas it may reach)? Can one person hold
    several roles (an admin in one tenant, a member in another, a customer and a
    staff member), and how do they switch between them? Who works in the
    backoffice (operators, support, admins of the product itself), and how
    separate must it be from the customer-facing front: same app with its own
    shell, or a separate app? Record the need and the candidates; stage 3 decides.
    See `docs/kit/ux.md` § _Shells and role switching_.

### PRD, derived and then confirmed

1. **Features**: cluster the capabilities into `F<nn>`. Let the author merge,
   split and rename.
2. **Journeys**: the end-to-end outcomes (`J<nn>`), each split into one
   journey per persona (`J<nn>.<n>`) with its tasks
   ([requirements.md](../spec-driven-development/requirements.md) § _Journeys_).
3. **Requirements**: the checklist in
   [requirements.md](../spec-driven-development/requirements.md) on each feature, giving
   `F<nn>-R<nn>` with testable acceptance.
4. **Access model**: the persona × capability table, consistent with every
   refusal. Record a recommendation of Oso or SpiceDB in `technology.md`,
   with the criteria in `docs/kit/security.md`. Stage 3 decides.
5. **Domain model**: per `docs/kit/data-model.md` § _Discovering it_. Use the ER diagram
   and walk every journey across it. High level only.
6. **Design brief**: ask the UX questions in `docs/kit/ux.md`, and write
   `docs/requirements/ux.md`. Then prototype with Lovable. Lovable has no
   CLI, so the work is split:
   - the agent writes the prompt for the effortless tasks from the brief to
     `docs/requirements/ux/lovable-prompt.md`
   - the person runs it in Lovable, iterates, and drops screenshots of the
     chosen screens into `docs/requirements/ux/`
   - the agent writes the notes on what to keep, and references the
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
   separated (or the candidates, until stage 3 decides). In
   `docs/requirements/ux.md`, give each shell's home and navigation.
9. **Technology triggers**: scan every requirement against
   `docs/kit/technology-decisions.md`. For each trigger the settled stack does
   not cover, record it in `technology.md`: the need, the requirement IDs,
   the volumes, the data class and the candidate options. Stage 3 runs the
   dialog and the user decides. A trigger nobody has decided blocks only the
   items that need it.
10. Non-functional requirements and release slices go into `prd.md`.
11. Run the checks in [requirements.md](../spec-driven-development/requirements.md),
    then `pnpm plan:check --stage requirements`.

## Restartable and non-destructive

- Each section and file carries a marker
  (`<!-- kickoff: section=scope state=decided updated=… -->`), which
  `plan:check` reads.
- A re-run asks only what is `open` or `partial`, plus overdue deferrals and
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
- The verdict is `ready-pending-decisions` or better.
- `plan:check --stage requirements` passes, and a re-run of this stage asks
  nothing new.
- Continue with stage 3.
