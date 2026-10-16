# Running several agents in one repository

Everything in this file follows from one fact: **the working tree, the index,
HEAD, the stash, the ports and the database are all shared unless you make
them not shared.**

## Shared resources and their rules

| shared thing                               | the rule                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| working tree                               | stage by path, never `git add -A`; work in a worktree                                                                                                                |
| stash (one per repo, across all worktrees) | never `git stash`. Copy a file to a scratchpad, or `git show HEAD:<path>`                                                                                            |
| HEAD (per worktree)                        | each code-writing subagent gets `isolation: "worktree"`, which the **spawner** must pass                                                                             |
| ports                                      | derive ports from a hash of the checkout path; kill only what an abandoned run of this checkout recorded (§ _Ports_)                                                 |
| `pkill -f <script>`                        | matches processes in every worktree: stop by PID, within your own checkout                                                                                           |
| dev database                               | each worktree has its own PGlite database (`pnpm db:local`), with snapshots before every migration; shared environments change only by promotion                     |
| tools that glob from the root              | exclude `.claude/worktrees/**` everywhere                                                                                                                            |
| `.dev.vars` / `.env` (gitignored)          | absent in worktrees: `pnpm bootstrap` symlinks them from the main checkout. Use a symlink, not a copy, so it cannot drift                                            |
| `node_modules`                             | absent in fresh worktrees: `pnpm install` in each (fast, hard-linked). **Never symlink `node_modules`**: workspace links would resolve to the main checkout's source |
| CPU during compile-heavy work              | parallel cold compiles are slower than serial warm ones: one warm checkout for recording or visual work                                                              |

## Ports

A port sweep sends `SIGKILL`, so it kills only what it can prove is an orphan.
**This checkout's working directory is not that proof**: a second journey run in
the same checkout, and a dev server that sits on a derived port, share the cwd of
an orphan and are alive. So the journey stack host **stamps** itself once ready
(`stack.json` in scratch): its pid, a random nonce, its control URL, and every
listener on its ports with that process's start time. The next sweep then:

| finds on a port                                                        | does                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| another checkout's listener                                            | refuses, `JOURNEY-002`                                 |
| a listener in no checkout, or whose cwd cannot be read                 | refuses, `JOURNEY-003`                                 |
| this checkout's, and the stamped host answers `/whoami`                | refuses, `JOURNEY-005`: a live run owns it             |
| this checkout's, not recorded by an abandoned stack, or its pid reused | refuses, `JOURNEY-006`, naming the pid to stop by hand |
| this checkout's, and the host could not be asked (a timeout)           | refuses, `JOURNEY-007`                                 |
| a listener the abandoned stack recorded, same start time               | kills it                                               |

Every port is judged before anything is signalled. To run alongside a live
run, set `JOURNEY_APP_PORT` and `JOURNEY_DB_PORT`.

`pnpm db:local stop` follows the same rule for its own servers: it asks the
server to stop over its control channel, with the token only that server holds,
and signals a pid only after matching the exact script, this checkout's data
directory and lock, and a start time no later than the lock. When `ps` cannot
answer, nothing is signalled.

## Worktrees

```bash
pnpm claim <ID>                     # an item: the branch is its lowercased ID
git fetch origin <id> && git worktree add .claude/worktrees/<id>-<slug> <id>
git worktree add .claude/worktrees/req-<slug> -b req-<slug> origin/dev   # a requirements branch
# inside it:
pnpm install && pnpm bootstrap
```

- An item's worktree is created from its claim branch (`pnpm claim <ID>`;
  `.agents/skills/git-workflow-and-versioning/SKILL.md` § _Starting an item_).
  Anything else forks from **`origin/dev`**, not `dev`. Local `dev` lags by
  every merge since somebody last fast-forwarded it.
- **Every session works in its own worktree, and the user names it.** As soon
  as the user asks for something, the agent **proposes** a name: derived from
  the item (`f03-012-<slug>`), a requirements change (`req-<slug>`), or the
  request itself (`<verb>-<topic>`). The user can accept it or change it
  **before** the worktree is created. Use one AskUserQuestion with the proposal
  first, and "keep it" as the default. Read-only work (answering a question,
  a pickup, a report) needs no worktree until the first write. The name tells
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

There are two halves, split by what merges:

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
  name.
- **Write it to the main checkout**, never inside a worktree, where it dies with
  the tree. If the harness refuses that write, **say that the handoff was not
  written**.
- The pickup (`.agents/skills/context-engineering/pickup.md`) reads all
  handoffs for the newest date and checks each against `git`. `pnpm bootstrap`
  lists them at the start of a session.
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
  **snapshot**: it checks the commit out into `.ci-local/run-<sha>-<random>/` (a shared clone, one per run, behind a per-SHA lock) (with its own
  `pnpm install --offline`, never a symlinked `node_modules`), so the worktree
  stays free to edit. Anything else long-running that reads the working tree
  either snapshots the same way, or the main thread works elsewhere until it
  finishes.
- **A sub-agent that writes gets its own worktree** (`isolation: "worktree"`).
  Sub-agents that only run scripts and report may share the session's tree.

## Named agents

Base ships no persona agents (`.claude/agents/` holds the reviewers `/ship`
fans out to). A project that adds named agents keeps two rules:

- **Scope is a boundary.** Out-of-scope work becomes a **plan item** (through
  `/spec`), never a message to another agent. An item survives the session
  and shows in `plan:status`. A message is a relay.
- **Never relay an authorisation.** "The orchestrator said it was fine" says
  nothing about whether you may.

## Before starting the second agent

- [ ] Worktree hooks are installed and tripped
- [ ] Ports are derived per checkout
- [ ] Each checkout gets its own test database (PGlite), and dev DB branches are
      per checkout, or migrations are generated offline against `origin/dev`
- [ ] `.claude/worktrees/**` is excluded from every globbing tool
- [ ] `pnpm bootstrap` repairs a fresh worktree and prints what it did
- [ ] The `context-engineering` skill (handoff and pickup) is installed
