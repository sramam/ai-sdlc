# Skills

A skill holds the **procedure and the remembering**, not the judgement. Each one
below exists because doing its job by hand went wrong.

## In the starter (generalised from door_nexa; the skills are in [`.claude/skills/`](../../.claude/skills/))

**Discovery and planning**

| skill             | does                                                                                                                                                                                                                                                                                                                                                                                             | why it exists                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `kickoff`         | _how_ it gets built, in two passes around `/idea` (never calling it). First pass: people, SDLC defaults, budget, first accounts, working agreements. Second pass: decides the stack and every recorded technology trigger (the user decides, through the dialog), apps, packages and scope, the backoffice split, architecture and AI architecture. Restartable; `revisit <topic>` keeps history | nothing gets built on an unasked question. Named `kickoff` because Claude Code's built-in `/init` exists |
| `idea`            | _what_ gets built: conversation → BRD + PRD, or import and vet. Discovers personas, tenancy and access, the domain model, the design brief and AI capabilities; **records** decisions for kickoff; `check` runs the implementability pass; `status` gives the verdict. Restartable                                                                                                               | a gap found here costs a question; found in QA, it costs a rebuild                                       |
| `add-requirement` | every request after discovery: triage, answer from the repo, ask only what is missing, run the technology dialog (the user decides), and land requirements on their own branch before the code                                                                                                                                                                                                   | the only door into the locked requirements; no technology is added silently                              |
| `plan`            | `/plan` writes the plan (foundation `X-` items first, then features by journey); `/plan next` claims an item and creates its worktree (the user confirms the name); `/plan sync` reconciles                                                                                                                                                                                                      | the plan is worked, not admired, and a blocked agent always has a next move                              |

**Working, landing and continuity**

| skill             | does                                                                                                                                                                                                             | why it exists                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `land`            | committed branch → `dev`: check it is current, push, `ci:local` (posts `local-ci` on the pushed SHA), PR, re-check, **merge commit**, then a `local-ci` status on the new `dev` tip                              | landing four PRs in one day hit five distinct mistakes; with CI local, this is the gate |
| `handoff`         | writes `docs/handoffs/YYYY-MM-DD-<branch>.md` to the main checkout (exempt from the worktree guard), last; prints the `/pickup` line                                                                             | a session's context dies with it                                                        |
| `pickup`          | reads every handoff for the newest date, verifies each against `git`, and says whether a report, a plan sync or a stale claim is due                                                                             | a handoff is a report, not a fact                                                       |
| `commit-reviewer` | staged diff: scope, message accuracy, trailers, secrets                                                                                                                                                          | runs as a commit hook                                                                   |
| `code-reviewer`   | nine criteria: sufficient, necessary, minimal, well-tested (no DB fakes), honest about unknowns, secure and access-safe, lifecycle-correct, boundary types, screen quality; `n/a` where a criterion cannot apply | runs as a commit hook                                                                   |
| `progress-report` | `docs/progress/YYYY-MM-DD.md` from `Progress:` trailers: Shipped, Decided, Cost a day, Open                                                                                                                      | visibility with no extra bookkeeping                                                    |

## Not yet generalised from door_nexa (they arrive with their tooling)

| skill                                                   | does                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `journey-add` / `journey-test` / `journey-ready-for-qa` | describe a journey; record it (three passes) and test it (one pass); a person releases it to QA. Arrives with the journeys package |
| `release`                                               | tags a green commit on `origin/dev`; notes from `Progress:` trailers; refuses a red or missing `local-ci` status                   |
| `coverage-report`                                       | refreshes the generated coverage figures and writes the reading of them. Arrives with the coverage gate                            |

## Added later, if the project wants them

| skill                | when                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `doc-validator`      | once docs multiply: succinct, complete, no contradictions with guardrails, links resolve    |
| `monorepo-validator` | once there are three or more packages: each has `agents.md` and is referenced from the root |
| `status-report`      | when stakeholders want a weekly status: figures from `plan:status`, narrative written       |
| `build-rationale`    | when ADRs accumulate: keeps the decisions index current                                     |

## Writing skills well

- **The skill text is read by an agent mid-task.** Lead with the steps; put the
  reasons after them, briefly. door_nexa's `journey-test` reached 760 lines,
  which is too long.
- **Name what the skill may not decide.** For example, `land` may not merge red,
  may not decide a failure is "unrelated", and may not release to QA.
- **End by printing the next command** (the `/pickup …` line), so the
  instruction travels with the output.
- **The count of criteria in the header must equal the number of sections.**
  door_nexa's code-reviewer said four criteria and had eight, and the
  unreported four included tenant safety. Put a census on your own skills.

## Tools that worked

- **`gh` CLI**: use `gh api` for anything compared; `--json` is fine for reading.
- **A capture outbox** for email in dev and e2e, written to disk with an index.
- **`pnpm dev:session`** (the `dev-session` recipe): completes a real passwordless sign-in for a seeded
  account and writes a cookie jar, so agents can `curl` authenticated pages.
  It refuses production and refuses when the target is ambiguous.
- **`pnpm bootstrap`**: environment doctor that prints a line per check and
  repairs what it can (env symlink, generated client).
- **`pnpm ci:local`**: _the_ CI. door_nexa built it as a fallback for an
  Actions outage; here it is the default. Give it fingerprinting, three-answer
  steps and a `local-ci` commit status.
- **`pnpm playground`**: a long-lived local DB and server for clicking around,
  with its data directory and ports per checkout and a pid lock against `--fresh`.
- **`scripts/one-of/`** (gitignored) for throwaway scripts.
- **Prefer `gh` and the REST/GraphQL API to an MCP connector** for scripted work.
  Connectors often carry small daily quotas shared by every agent; door_nexa's
  allowed 300 calls a day.
