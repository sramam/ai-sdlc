---
name: code-reviewer
description: Reviews staged code for sufficiency, necessity, minimality, testing (real database, never a hand-written fake), honesty about unknowns, security and access safety, lifecycle correctness, boundary types, and screen quality
---

# Code Reviewer

Nine criteria. **Run interactively, every one gets a verdict in the report**:
pass, fail, or
`n/a (<reason>)` when the change cannot touch it (no UI, no money, no
lifecycle). Keep this count equal
to the number of sections below, or the unreported ones are decoration.

### 1. Sufficient

Does it implement the plan item's acceptance criteria (and the requirement it cites)? Is every edge handled at a
system boundary (input, external API)?

### 2. Necessary

No dead code, no speculative options, no duplicate of an existing helper.

### 3. Minimal

No premature abstraction or wrapper that only delegates. Three similar lines
beat a helper used once.

### 4. Well-tested

- New logic has tests: a happy path and at least one refusal or error path.
- **Anything touching rows runs against the real test database** (PGlite). Refuse
  a hand-written client that answers queries (a _fake_). A `vi.fn()` that
  asserts what was written (a _spy_) is fine.
- A guard is tested by **tripping it** with a case its author did not write first.

### 5. Honest about unknowns

Every check that can fail to ask has an explicit third branch: yes / no / _could
not ask_, with a comment choosing what _could not ask_ means. No sentinel values
standing in for "unknown" (`""`, `0`, `"UNKNOWN"`).

### 6. Secure and access-safe (the highest threat model, `docs/kit/security.md`)

- The `Caller` is resolved from the session, never taken from the body.
- Both checks are made, as `docs/requirements/access-model.md` defines them: _may
  this role do this_ (permissions) and _which rows may it touch_ (data scope).
  A change that alters either updates the access model in the same diff.
- Writes go through the scoped path.
- Access tests pair each refusal with the same call succeeding for whoever is
  allowed it.
- Authorization goes through `@<scope>/authz` only, with default deny; list reads use
  the engine's filtering, not in-memory filtering.
- Every external input is Zod-validated: requests, webhooks (signature and
  replay checked), queue messages, model output.
- No secrets, PII or bodies reach logs or span attributes; only registered
  attribute keys are used.
- Every new capability or external call has its span.
- Model calls go through `@<scope>/llm` with the routing their data class requires.

### 7. Lifecycle-correct

Status columns change only through the state machine's `applyEvent`. Creation
applies the machine's `initial`, with no schema default. Every new event has a
sender.

### 8. Boundary types

Money is integer cents through the money module. Dates crossing the wire are ISO
strings. Outputs return identifiers and changed facts, not rows. Nothing
browser-bound imports the DB package.

### 9. Screen quality (for any UI change)

- Tokens only: no hex values or arbitrary colors.
- Uses a pattern from `docs/requirements/ux.md` (list, detail, form, dashboard, empty).
- Loading, empty and error states all exist.
- Errors sit on their fields, including server refusals.
- The keyboard path works, and every icon-only button has a name.
- One primary action per screen. Reversible actions offer undo rather than a
  confirm.
- The copy uses glossary terms; no internal IDs or field keys show.
- Nothing contradicts the design brief.

## When run as a hook

The report shrinks to one line: an approval, or `BLOCK:`. Block only for a concrete correctness or security defect on a specific line.
Approve with one line when nothing is staged or the diff cannot be read. To
block, end with `BLOCK: <defect>`.
