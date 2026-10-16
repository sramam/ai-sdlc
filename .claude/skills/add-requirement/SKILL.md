---
name: add-requirement
description: Every new ask after discovery — a one-liner, a bug, a feature, a new area. Triages it, answers what the requirements already say, asks only what is missing, runs the technology-decision dialog when something new is implied (the user decides), and writes requirements on their own branch under the requirements lock, plus the architecture and plan items. The only way requirements change after discovery.
---

# Add requirement

During discovery, `/idea` writes the requirements and `/kickoff` decides. After
discovery, **this skill is the only door**. It never calls `/idea` or `/kickoff`;
where it needs their methods, it follows them itself, under its own lock.

## Step 1 — Triage

| kind                            | example                                               | outcome                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **trivial**                     | a typo, a rename, a version bump                      | no questions. Either a commit with `No-Item: <reason>`, or `Progress:` on an existing item. **Requirements untouched**                                           |
| **within the requirements**     | a bug, or work an existing requirement already covers | the quick checklist; a plan item citing the requirement. **Requirements untouched**                                                                              |
| **changes a requirement**       | a new field, a changed rule, a new refusal            | the quick checklist; the requirement edited **in place, with history**; plan items                                                                               |
| **new feature**                 | a capability no feature covers                        | the full checklist from `/idea` (`.claude/skills/idea/SKILL.md`); a new `F<nn>`, journey steps and plan items                                                    |
| **new persona or product area** | a new audience or surface                             | `/idea`'s **conversation method** for that area: persona discovery, the relevant BRD themes, then the PRD steps. All of it is done here, under this skill's lock |

If you are about to make a decision the requester would want to make, it is not
trivial.

## Step 2 — Answer from the repository first

Read `docs/requirements/`, `docs/architecture.md`, the ADRs, the code and the
plan, and cite what you find: "F03-R04 already says reminders stop on
cancellation." **Never ask what the repository already answers.** For a bug,
**reproduce it first**.

## Step 3 — Ask only what is missing

The **quick checklist**:

- **who**: the persona
- **outcome**: what they can do afterwards; done means Given / When / Then
- **which feature**, and is it inside MVP scope?
- **access**: does it change who may see or do something?
- **domain**: does it add an entity, relationship or lifecycle?
- **screen**: which pattern and shell; the loading, empty and error states
- **security**: the asset, the attacker, what stops them
- **observability**: what would show it works in production
- **what must not change**

For a new feature or area, use the full checklist instead. Ask in batches, with
recommendations.

## Step 4 — New technology? Run the dialog

Scan the request against the triggers in `docs/kit/technology-decisions.md`. If
it needs anything the settled stack and the existing ADRs do not cover, **run
the dialog**:

1. frame the need
2. list the options, including the settled stack alone and "not now"
3. compare them on the criteria, with current sources
4. recommend, with a confidence level
5. **the user decides**
6. write the ADR

Never add a dependency without one. Meanwhile, keep working on whatever does not
depend on the decision.

## Step 5 — Write it down, traceably

1. **Requirements first, on their own branch.** If this session holds another
   worktree, land or close it first (one live worktree per session). Before
   writing, check that no
   other unmerged branch is changing `docs/requirements/`
   (`docs/kit/hooks.md`). If one is, report it, and work on something else until
   it lands. Then:
   - create a worktree and branch named `req-<slug>` from `origin/dev`
   - claim the lock: `echo "$CLAUDE_CODE_SESSION_ID add-requirement" >
.claude/requirements-session`
   - write the new or changed `F<nn>-R<nn>`, journey steps, and the access,
     domain and design-brief updates, each marked with the date and the request
   - record any technology decision in `docs/requirements/technology.md`
   - run the **implementability pass** on the affected features yourself
     (`/idea`'s _three passes_, implementability section) and fix or record
     what it finds, still under the lock
   - commit with `Requirements: add-requirement`, release the lock, and land
     it with `/land`. A requirements PR contains nothing else.
2. **Architecture**: if a component, app, package or integration changes,
   update `docs/architecture.md`, citing requirement IDs and the ADR.
3. **Plan**: items in `docs/plan/items/` citing the requirements, with
   `depends:` and a milestone.
4. Run `pnpm plan:check` (it selects its stage).

## Step 6 — Readiness

The implementability pass ran in step 5, under the lock. Anything still open is
a `Q-` with `blocks:`.

## Done when

- The triage outcome is written: a `No-Item` commit, a plan item, edited
  requirements, or a new feature.
- Every checklist line is answered, cited, or a `Q-` with `blocks:`.
- Any technology decision is an ADR the user made, or is explicitly pending,
  with the items it blocks.
- The requirements branch has landed (if there was one), the lock is released,
  and `plan:check` passes.
- Print what will be built, and which items are now ready.
