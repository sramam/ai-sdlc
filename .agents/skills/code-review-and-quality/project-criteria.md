# Project criteria

Seven criteria upstream's five axes do not know about, because they come from
this project's stack and guards. Upstream's correctness, readability,
architecture and simplicity axes already cover whether the change is
sufficient, necessary and minimal; these are added to its report, not
substituted for it. Every one gets a verdict: pass, fail (with `file:line`), or
`n/a (<reason>)` when the change cannot touch it. Keep this count equal to the
number of sections below.

### 1. Tested against the real thing

- Anything touching rows runs against the real test database (PGlite). A
  hand-written client that answers queries (a _fake_) is a fail, and blocks the
  commit. A `vi.fn()` that asserts what was
  written (a _spy_) is fine. This supersedes upstream's "fake DB" and
  `jest.mock('./database')` examples.
- A guard is tested by tripping it, with a case its author did not write
  first.

### 2. Honest about unknowns

A check that can fail to ask has three answers: yes, no, and _could not ask_,
with a comment choosing what _could not ask_ means. No sentinel standing in for
"unknown" (`""`, `0`, `"UNKNOWN"`).

### 3. Access-safe

- The caller comes from the session, never from the body.
- Both checks, as `docs/requirements/access-model.md` defines them: _may this
  role do this_ and _which rows may it touch_. A change to either changes the
  access model in the same diff.
- Authorization goes through `@<scope>/authz` only, default deny; list reads
  use the engine's filtering, not filtering in memory.
- Every external input is Zod-validated: requests, webhooks (signature and
  replay), queue messages, model output.
- No secrets, PII or bodies in logs or span attributes; only registered
  attribute keys. Every new capability or external call (database, model,
  authorization, email, a vendor) has its span (`docs/kit/observability.md`).
  Model calls go through `@<scope>/llm` on the route their data class allows.

### 4. Lifecycle-correct

Status columns change only through the state machine's `applyEvent`. Creation
applies the machine's `initial`, with no schema default. Every new event has a
sender.

### 5. Boundary types

Money is integer minor units through the money module. Dates crossing the wire
are ISO strings. Outputs return identifiers and changed facts, not rows.
Nothing browser-bound imports the DB package.

### 6. Screen quality (any UI change)

Tokens only, no raw colours. A pattern from `docs/requirements/ux.md`, with
loading, empty and error states. Errors on their fields, server refusals
included. A keyboard path, and a name on every icon-only button. Glossary
words; no internal IDs on screen. Nothing contradicts the design brief.

### 7. Context quality (any change to text a model acts on)

Skills, `AGENTS.md`, the kit, requirements, plan items, guard messages, and
every prompt, tool description or agent definition the product ships: each
added or changed passage meets
[the context checklist](../context-engineering/context-quality.md) (the five
tenets, and the prompt structure: static first, dynamic data last, concise,
the output specified). As a hook, block only for a
security line (a secret, an instruction taken from fetched content, a widened
permission nobody was told of) or a fidelity line that states something the
diff itself contradicts.

## When run as a hook

The report shrinks to one line: an approval, or `BLOCK: <defect in one
sentence>` at the end. Block only for a concrete correctness or security defect
on a specific line. Nothing staged, or a diff that cannot be read, is an
approval with its reason.
