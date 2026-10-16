# Running several agents in one repository

Everything in this file follows from one fact: **the working tree, the index,
HEAD, the stash, the ports and the dev database are all shared unless you make
them not shared.** Each row below was a real incident.

## Shared resources and their traps

| shared thing                               | what went wrong                                                                                                       | the rule                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| working tree                               | `git add -A` swept another agent's work into a commit                                                                 | stage by path; work in a worktree                                                                                                                          |
| stash (one per repo, across all worktrees) | a `pop` applied another session's stash                                                                               | never `git stash`. Copy a file to a scratchpad, or `git show HEAD:<path>`                                                                                  |
| HEAD (per worktree)                        | four subagents sharing one HEAD: one was reset four times mid-edit; a 914-line commit landed on another lane's branch | each code-writing subagent gets `isolation: "worktree"`, which the **spawner** must pass                                                                   |
| ports                                      | an e2e run `SIGKILL`ed another agent's dev server on :3000, then probed that server as its own                        | derive ports from a hash of the checkout path; kill only listeners whose cwd is this checkout                                                              |
| `pkill -f <script>`                        | matched processes in every worktree                                                                                   | stop by PID, within your own checkout                                                                                                                      |
| dev database                               | `migrate dev` applied a half-finished migration to the shared branch, and every other agent then hit drift            | per-checkout DB branches from day one; generate migrations offline against `origin/dev`'s schema (Prisma: `migrate diff`; Drizzle: `drizzle-kit generate`) |
| tools that glob from the root              | vitest collected every other worktree's tests                                                                         | exclude `.claude/worktrees/**` everywhere                                                                                                                  |
| `.dev.vars` / `.env` (gitignored)          | absent in worktrees, so "DATABASE_URL is not set"                                                                     | `pnpm bootstrap` symlinks them from the main checkout. Use a symlink, not a copy, so it cannot drift                                                       |
| `node_modules`                             | absent in fresh worktrees, so hooks failed open                                                                       | `pnpm install` in each worktree (fast, hard-linked). **Never symlink `node_modules`**: workspace links would resolve to the main checkout's source         |
| CPU during compile-heavy work              | three parallel cold compiles were slower than serial warm ones                                                        | one warm checkout for recording or visual work                                                                                                             |

## Worktrees

```bash
git worktree add .claude/worktrees/<name> -b <branch> origin/dev
# inside it:
pnpm install && pnpm bootstrap
```

- Fork from **`origin/dev`**, not `dev`. Local `dev` lags by every merge since
  somebody last fast-forwarded it.
- **Every session works in its own worktree, and the user names it.** As soon
  as the user asks for something, the agent **proposes** a name: derived from
  the item (`f03-012-<slug>`), a requirements change (`req-<slug>`), or the
  request itself (`<verb>-<topic>`). The user can accept it or change it
  **before** the worktree is created. Use one AskUserQuestion with the proposal
  first, and "keep it" as the default. Read-only work (answering a question,
  `/pickup`, a report) needs no worktree until the first write. The name tells
  anyone looking whose branch it is.
- Land a worktree by merging `origin/dev` _into_ it, then opening a PR. A worktree
  cannot check out `dev`, because the main checkout holds it.
- Close it when finished: `git worktree remove …` and update the registry.

**The hooks that enforce this** are described in [hooks.md](hooks.md):

- refuse writes and commits in the main checkout (exempt per session, keyed by
  session id)
- refuse a base other than dev
- allow one _live_ worktree per session
- record provenance

## Provenance: which agent made this?

`git log` says _what_ changed. With five agents it could not say _which line of
work_ changed it. There are two halves, split by what merges:

|                    | scope         | where                                         |
| ------------------ | ------------- | --------------------------------------------- |
| branch → session   | global        | `Worktree:` / `Session:` commit trailers      |
| worktree → session | machine-local | append-only `.claude/worktree-registry.jsonl` |

- The **session id** is the key. Names can be renamed.
- "Created by" is not "occupied by". Label it that way.
- A worktree nobody recorded is claimed by the first session found in it, as
  `entered` and never `created`.

## Handoffs

- `docs/handoffs/YYYY-MM-DD-<branch>.md` is gitignored. Put the branch in the
  name: date alone let two agents clobber each other.
- **Write it to the main checkout**, never inside a worktree, where it dies with
  the tree. If the harness refuses that write, **say that the handoff was not
  written**.
- `/pickup` reads all handoffs for the newest date and checks each against `git`.
  Where the two disagree, the disagreement is the finding.
- Do not grow handoffs into a coordination protocol. The only cross-agent channel
  that merges is git. Work that two agents must agree on belongs in a plan item or a `Q-` file.

## Long-running work goes to a sub-agent

Scripts that take more than about a minute run **in the background**, so the
conversation is never blocked on them. That covers `ci:local`, full test
suites, journey recording and testing, builds, provisioning, seeding and
migrations. Either:

- **a sub-agent** (the Agent tool, in the background) when the run needs
  judgement: reading failures, re-running a flaky step, summarising. Or
- **a background shell** (`run_in_background`) when it only needs to finish.

The main thread keeps talking with the user and doing work that does not depend
on the result, and reports when the result arrives. **Never predict or invent
a result that has not arrived.**

Two rules keep this safe:

- **A background run must not race the main thread's edits.** `ci:local` tests a
  **snapshot**: it checks the commit out into `.ci-local/run-<sha>/` (a shared clone) (with its own
  `pnpm install --offline`, never a symlinked `node_modules`), so the worktree
  stays free to edit. Anything else long-running that reads the working tree
  either snapshots the same way, or the main thread works elsewhere until it
  finishes.
- **A sub-agent that writes gets its own worktree** (`isolation: "worktree"`).
  Sub-agents that only run scripts and report may share the session's tree.

## Named agents (personas and lanes)

door_nexa had named subagents (`.claude/agents/*.md`): one per persona of _its_
product, plus platform, infrastructure, project-manager and orchestrator. In a
new project, create persona agents only once discovery has settled the
personas, and only for personas with enough journeys to need an owner. A shared `_shared.md`
held the common rules. What held up:

- **Scope is a boundary.** Out-of-scope work becomes a **plan item** (through
  `/add-requirement`), never a message to another agent. An item survives the session
  and shows in `plan:status`. A message is a relay.
- **Never relay an authorisation.** "The orchestrator said it was fine" says
  nothing about whether you may.
- **An orchestrator lane** decides whose turn it is on scarce resources (the
  single warm recording checkout) and lands PRs. A HEAD lock covers the short
  exclusive window (switch → add → commit → push). Everything else stays parallel.
- **A simultaneous all-clear is a starting gun.** Releasing six waiting lanes at
  once recreated the contention. Gate on conditions checked inside the command
  itself (load, nobody else running), not on a broadcast.
- Subagents cannot create worktrees themselves, because the harness refuses git
  outside their checkout. Isolation must be passed by the parent on every fan-out.
  Agent frontmatter has no field for it.

## Before starting the second agent

- [ ] Worktree hooks are installed and tripped
- [ ] Ports are derived per checkout
- [ ] Each checkout gets its own test database (PGlite), and dev DB branches are
      per checkout, or migrations are generated offline against `origin/dev`
- [ ] `.claude/worktrees/**` is excluded from every globbing tool
- [ ] `pnpm bootstrap` repairs a fresh worktree and prints what it did
- [ ] Handoff and pickup skills are installed
