# Journey ready for QA

**Checklist (read this first; details follow):**

1. **A person has said this journey is ready.** If nobody has, ask — do not infer it from green.
2. Read the walk's page: `docs/journeys/<id>-<slug>/<persona>/README.md` (status line, _Test these by hand_).
3. Every path green. **Red is never released**; stop and name the failing path.
4. Add one line under `## Signed off` in `docs/journeys/ready-for-qa.md`.
5. `pnpm journeys:index` — republishes from disk; confirm `status republished: <id>/…`.
6. Commit the sign-off and the regenerated pages (stage by path), then `pnpm land`.

**The third pair of hands.** `/journeys add` registers a journey and `/journeys test` records it;
neither releases one. Green says the paths that exist pass — it cannot say the right paths were
written, that the copy reads well, or that the journey is worth a tester's afternoon. That is a
judgement, and **a person makes it**. This skill carries out a decision already taken.

## The sign-off line

```markdown
- [J12 Cancelling a session](J12-cancelling-a-session/README.md) — 2026-10-15 — three paths green; spend the time on time zones, which no recording crosses
```

- **The id releases it** (`- J12` at the start of a line; the link is for the reader).
- **Name the biggest gaps.** "Three paths green" is the least useful half; the line earns its place
  by saying what the recordings could not reach — read _Test these by hand_ for it.

## Why it is a skill rather than one line

The sign-off is one hand-written line; the release is the index, every journey's pointer page and
each walk's status line. Adding the line alone leaves the page a tester lands on saying the
opposite. `pnpm journeys:index` rewrites all of them **from the recordings already on disk** — no
browser, no stack, seconds.

**Do not re-record to publish a sign-off.** It changes no recording, and a re-run can fail on
unrelated visual drift — blocking a release for a reason that has nothing to do with the decision.

## Taking one back

Delete the line and run `pnpm journeys:index`. The pages follow in both directions. A released
journey that goes red returns to _In Dev Testing_ by itself: a sign-off does not override red.

## What this skill must not do

- **Decide** that a journey is ready, or release one because it went green.
- **Release a red journey**, or one with an unrecorded path.
- **Re-record** — that is `/journeys test`, a different act with a different review.
- **Edit a generated page by hand** — each says _never edit this file_, and the next run overwrites it.

Next: `pnpm land`.
