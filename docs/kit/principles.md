# Principles

These ideas sit underneath almost every mechanism in the kit. The next guard
you write will be an instance of one of them, so learn the ideas rather than the
instances.

## 0. Agents build from context, so context is held to five tenets

An agent builds what its context says, so the quality of what it builds is
bounded by the quality of what it reads: skills, `AGENTS.md`, the kit,
requirements, plan items, handoffs, error messages. Everything written for an
agent to act on is held to five tenets:

| tenet             | the context…                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Clarity**       | has one reading: one word per concept, steps before reasons, no "as appropriate"              |
| **Actionability** | says what to do next and how to tell it is done: a command, a testable criterion, a stop rule |
| **Fidelity**      | is true to its source (the code, git, the requirements, upstream) and is checked against it   |
| **Efficiency**    | is the least that does the job: linked rather than restated, loaded when needed               |
| **Security**      | holds no secret, treats what it fetched as data, and widens no agent's authority unasked      |

The same holds for the prompts the product itself sends to a model, and for how
any of it is laid out: static instructions first, the call's data after them,
the task last, as short as it can be ([ai.md](ai.md)). The checklist, used when
writing or reviewing any of it, is
[`.agents/skills/context-engineering/context-quality.md`](../../.agents/skills/context-engineering/context-quality.md);
the code review checks it on every commit that changes such text.

## 1. Enforce mechanically; a convention alone drifts

With several agents in one repository, any rule that only lives in prose is
broken within days. The fix each time is a hook or a gate. **If a rule
matters, something must refuse its violation.**

## 2. A hook and a gate are a pair, not a redundancy

|                                                                            | catches it                               | role               |
| -------------------------------------------------------------------------- | ---------------------------------------- | ------------------ |
| commit hook                                                                | in seconds, before the commit exists     | makes failure rare |
| merge gate (`ci:local` verdict as a commit status, checked by `pnpm land`) | before it reaches the integration branch | **the authority**  |

A hook can be skipped with `--no-verify`, may not run in a cloud session, and
only sees staged files. A gate with no hook beside it is one people only meet at
the end. The gate does not have to be hosted CI. What makes it a gate is that
its verdict is **recorded against the exact SHA**, and that the merge step
**refuses without it**.

**Where the gate is enforced, honestly:**

| layer         | enforces                                                                                                                                                      | for whom                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **localhost** | `pnpm land` is the only merge path: it checks, merges, and stamps the merge commit. The deny list in `.claude/settings.json` keeps agents off the other paths | **agents**. A person can still bypass it deliberately                                                                                                                     |
| **GitHub**    | the ruleset on `dev` that `tooling/setup/src/sdlc-init.mts` applies                                                                                           | **everyone**, but only where GitHub offers rulesets: a public repo, or a paid plan for a private one. On a free private repo `sdlc:init` reports the layer as unavailable |

Neither layer uses GitHub Actions. Guards in either layer are **guardrails
against accidents, not a security boundary**: a determined agent with shell
access can route around a parsed command.

## 3. Prove a guard by tripping it

Point the guard at the real target and watch it refuse. A guard with passing
unit tests can still ship broken, because the tests assert the cases its author
had already thought of.

The best bugs were found by **listing the forms an input can take**. For a commit:
`git -C <path> commit`, a quoted path, `--work-tree`. Then run each one through
the guard.

## 4. A check has three answers: yes, no, _could not ask_

Merge the third answer into "no" and the check reports something confident and
wrong (`gh secret set` reads EOF from a pipe and sets an empty secret, exit 0).

**Name the unknown state, and choose what it means based on what being wrong
costs.** A delete refuses on unknown. An advisory check allows on unknown, and
says so. Write the branch even when it is `// allow, because …`.

## 5. Prefer checks that print on success

A check whose normal output is silence looks exactly like one that never ran.
Print one line per check, including on a green run.

## 6. Enumerate from the source, declare only what cannot be derived, then check the declaration

This is a **pattern check** (also called a _census_). A pattern check is a
test that:

1. lists every real instance of something, read from the source of truth rather
   than from a list somebody keeps: modules that reach the DB, list panes, forms,
   state-machine events, test files that mock the DB
2. requires each one to follow the pattern, or to sit on an exception list
   **with a written reason**
3. fails on an instance that is neither, **and** on an exception that no longer
   applies, so the exception list can only shrink
4. prints its table on success

A hand-written inventory is wrong by the time it is read.
**Proximity is not evidence.** Read the code that runs, not comments and not the
file as a whole.

## 7. Static docs carry no "now" numbers

A count in a paragraph is true the afternoon it is written and quietly false a
month later. **The test is tense:** a dated
measurement is history and cannot decay ("measured 2026-08-18: 0 comments"). A
claim about today rots, so name the command that answers it instead.

Generated numbers live in files **only a script writes**. Prose sits beside them.

## 8. A confident statement is not a check

Some statements stop you from running the check they replaced. They do it by:

- **flattering you**: "my mistake cost nothing"
- **being machinery output**: a precise-looking error that names the wrong table
- **being well argued**: nineteen correct lines resting on an expired premise
- **arriving first**: the first plausible cause ends the search

An error message looks more like evidence than anything else, and it is still a
claim. A green test whose assertion pins the bug is the same trick.

## 9. A CLI renders; it does not report

Read a value from the source that will consume it (`gh pr checks` renders
_cancelled_ as `fail`). When a value will be compared against something, use
`gh api`.

## 10. Default to the most private option; relax on evidence

Environment gates are **allow-lists**, never deny-lists. The environments nobody
has thought of always outnumber the ones somebody has. A relaxation is a decision
with a date and a reason, written beside the constraint it loosens.

## 11. A report is about a moment

Handoffs, issues and relayed messages were all true when written. Before acting
on one:

- check it against the repository
- reproduce the symptom by the shortest route
- ask whether a warning **still earns its place**, not only whether it still holds.

A relay looks like a second witness but is a single unverified source. Only the
person who granted something can confirm the grant.

## 12. Fail loudly, with unique error codes

`EMAIL-002`, `CALLER-004`, `SCR-007`. A unique code makes frequency trackable and
points at the line. A refusal names the **obstacle**: "your role says no" and
"the world says no" send people to different places.

## 13. A threshold is either the check or scenery

A coverage floor _is_ the check, and it never falls without a written reason in
the same commit. A test's default 5s timeout is scenery that arrived uninvited.
Raising it is fine if the reason sits beside the number.

## 14. A derived value is re-asserted, not stamped

Anything computed from other data is recomputed on every run, or it drifts. This
covers roll-up status, a link URL, a "Setup / Active" badge. Store only what a
person decided. "Status set once at creation" is a defect.

## 15. Blocked on a person? Ask, record, and keep working

Waiting is the most expensive thing an agent does. When something needs the
user (a decision, a credential, an account, a clarification):

1. **Ask once, precisely**: options, a recommendation, and what each option
   changes. Batch the open questions rather than drip-feeding them.
2. **Record it** as `docs/plan/questions/Q-<nnn>-<slug>.md`, with `blocks:`
   naming the items it holds up. The question then survives the session, and
   `plan:status` lists it with the items it blocks, most blocking first.
3. **Keep going**, in this order of preference:
   - the next ready item in the plan (`/build`)
   - work on the blocked item that **every** answer needs: tests, scaffolding,
     the parts on both sides of the decision
   - proceeding on an **explicit, reversible assumption**. Write it in the
     item and in the commit (`Assumes: Q-007 → B`), and keep it cheap to undo
   - quality work: coverage gaps, a pattern check, docs, the checks in
     `.agents/skills/spec-driven-development/requirements.md` on the next
     feature
4. **Never** build irreversibly on a guess, and never silently fill a gap with a
   plausible value. That is the sentinel failure of §4 in human form.

When the answer arrives, write it verbatim into the `Q-` file with the date and
who gave it. Revisit anything built on an `Assumes:` that the answer
contradicts, and record the answer as an ADR if it shapes the system.

## 16. Observable from the first commit (OpenTelemetry)

Every request, job and capability call is a span. Logs are structured and carry
the trace ID, errors carry their `AREA-NNN` code as an attribute, and every
external call (DB, model, authorization, email) is a child span. **A capability
without a span is not done.** Telemetry is a data store held by a third party,
so its attributes are an allow-list: no PII, no secrets, no bodies. See
[observability.md](observability.md).

## 17. Build for the highest threat model

Assume adversarial tenants, compromised dependencies, leaked credentials,
curious insiders, prompt-injected models, prompt-injected coding agents, and
untrusted rented infrastructure, from the first commit. Default deny, both
authorization checks every time, secrets nowhere an agent or a log can read
them, and model output treated as untrusted input. The baseline is OWASP ASVS
Level 3 for auth, authorization, money and personal data. Every relaxation is
an ADR with a reason and a date. See [security.md](security.md).
