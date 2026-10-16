# Hooks, trailers and guards

Everything here ships in base (`.husky/`, `tooling/guards/`,
`.claude/settings.json`). A project configures it through `sdlc.config.json` and
never edits it in place.

## Commit trailers — the one grammar

Each trailer is a single line, parsed with
`git interpret-trailers --parse`, so prose that quotes a trailer is ignored.

| trailer                  | form                                                | rule                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Progress:`              | `Progress: <ITEM-ID> <free text: covered; remains>` | the ID is the first token, matched case-insensitively against `docs/plan/items/`. At least one commit on a branch carries it, unless `No-Item:` does                      |
| `Closes:`                | `Closes: <ITEM-ID>`                                 | only on the commit that finishes the item; once on `origin/dev`, the item reads _done_                                                                                    |
| `No-Item:`               | `No-Item: <reason>`                                 | for work that genuinely has no item (a revert, a dependency bump, a progress report). A commit trailer, not a PR-body line, so `ci:local` can check it before a PR exists |
| `Requirements:`          | `Requirements: kickoff\|spec`                       | required on any commit touching `docs/requirements/`. `idea` and `add-requirement`, the names before October 2026, stay valid in older history                            |
| `No-Test:`               | `No-Test: <reason>`                                 | a branch that changes source and no test (a rename, a type-only change, generated code). Without it, `ci:local`'s trailer check refuses such a branch                     |
| `Assumes:`               | `Assumes: Q-<nnn> → <option>`                       | building on an open question                                                                                                                                              |
| `No-Rerecord:`           | `No-Rerecord: J<nn> <reason>`                       | a route change that deliberately does not re-record a journey that visits it                                                                                              |
| `Co-Authored-By:`        | exactly `attribution.commit` from settings          | no model name                                                                                                                                                             |
| `Worktree:` / `Session:` | added by `prepare-commit-msg`                       | provenance                                                                                                                                                                |

**A trailer is an assertion, not proof.** `Requirements: spec` says a
requirements skill made the change; nothing proves which skill ran. The checks
keep the assertions consistent (every requirements commit carries one, every
item ID exists, a branch closes only its own item), which is what makes them
useful for reporting, not for security.

## Git hooks (husky)

| hook                 | does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit`         | `lint-staged`: lint, format, regenerate every generated artifact the staged files can change, and re-stage it. lint-staged appends filenames to the command, so wrap generators as `sh -c '…'`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `prepare-commit-msg` | appends `Worktree:` / `Session:` in a worktree (deduplicated on amend)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `commit-msg`         | enforces the trailer table above. It refuses a `docs/requirements/` change without `Requirements:`, which backstops writes the lock cannot see (`sed -i`). It refuses a `Progress:` or `Closes:` naming a missing item, and an attribution trailer that differs from settings.                                                                                                                                                                                                                                                                                                                                                               |
| `pre-push`           | refuses every update of `dev`, `staging` or `main`. It allows `main` into a repository with no branch at all (a new project's first push, asked of the remote with `git ls-remote`; a remote it cannot ask is refused). The other exception is a push made by `pnpm promote:*`, which writes a one-shot handoff (`<git-common-dir>/sdlc-promote-handoff`: nonce, exact SHA, exact ref) and passes the nonce in `SDLC_PROMOTE_NONCE`; the hook deletes it on use. No branch name is trusted. `sdlc:init` creates `dev` through the GitHub API, so it never pushes it. A GitHub ruleset on `staging`/`main` is the stronger, server-side layer |

## Claude Code guards (`type: command`)

Each runs as **`node tooling/guards/src/<name>.mts`**: Node 24 strips the types, and
no `node_modules` is needed, so a guard works in a fresh worktree before
`pnpm install`. A guard that needs `node_modules` fails open exactly there.

| event                            | script              | does                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PreToolUse `Edit\|Write`         | `requirements-lock` | refuses writes under `docs/requirements/` unless `.claude/requirements-session` (gitignored, in **this** checkout) names this session and `kickoff` or `spec`. Under `docs/requirements/sources/`: a marked session may Write a **new** file (an import); Edit, and Write over an existing file, are refused always; `sources/MANIFEST` is refused always (only `pnpm sources:add` appends to it) |
| PreToolUse `Edit\|Write\|Bash`   | `worktree-required` | refuses writes and `git commit` in the main checkout (`--git-dir` equal to `--git-common-dir`). **Exempt path: `docs/handoffs/`**, so a session's handoff can be written there. A session exemption is a file keyed by `$CLAUDE_CODE_SESSION_ID`                                                                                                                                                  |
| PreToolUse `Bash\|EnterWorktree` | `worktree-base`     | `git worktree add` must base on `origin/dev`. `EnterWorktree({name})` is refused because it cannot name a base; `{path}` is allowed                                                                                                                                                                                                                                                               |
| PreToolUse `Bash\|EnterWorktree` | `worktree-single`   | one _live_ worktree per session (this session's records intersected with `git worktree list`)                                                                                                                                                                                                                                                                                                     |
| SessionStart                     | `bootstrap`         | `node tooling/setup/src/bootstrap.mts --session-start`: one line per check (repairing the env and skill links), whether the security plugin is installed, and the newest handoffs, as the session's first context. Always exits 0                                                                                                                                                                 |
| PostToolUse                      | `worktree-trace`    | records created and entered events in the registry. Never fails a tool call                                                                                                                                                                                                                                                                                                                       |

**The requirements lock marks who is authoring in this checkout. It does not
lock across agents.** Concurrency is handled by branches: a requirements change
lands on its own branch and PR, **before** the code that depends on it. A skill
that finds another unmerged branch changing `docs/requirements/` (`git log
origin/dev..origin/<branch> -- docs/requirements` over the remote branches)
says so, and works on something else until that branch lands.

**One shared git-command parser** (`tooling/core/src/git-command.mts`) is used
by every guard. It computes _where git would actually act_ (`git -C <path>`,
quoted paths, `--work-tree`), rather than reading the session's cwd.

**Known gaps, stated rather than implied away:**

- Bash commands that write files (`sed -i`, heredocs) are not gated. `git commit`
  and `commit-msg` are the backstop.
- Harness-created subagent worktrees bypass PreToolUse.
- Guards scan whole command text, so a command whose body _discusses_ a guarded
  command is refused. Use `--body-file` and `git commit -F`.

**Every override is a comment on the command line**
(`# worktree-base: <reason>`), so the reason survives into the transcript.

## Agent reviewers (`type: agent`)

The commit review (`.agents/skills/git-workflow-and-versioning/commit-review.md`)
and the code review's project criteria
(`.agents/skills/code-review-and-quality/project-criteria.md`) run on
`git commit`. A project may add more. Every reviewer follows these rules:

1. **Fail open, and settle that before using any tool.** A reviewer with no
   tools, or handed a path outside the repo, approves. It cannot have found a
   defect in something it did not see.
2. **Block only through an exact sentinel line** (`BLOCK: <defect>`). An approval
   is one line and nothing else, so the tone of its prose cannot block.
3. **Block only on concrete defects.** Style is advisory, and so is a criterion
   that does not apply to the change (`n/a`).
4. **Never judge which model wrote something.** It cannot be observed.
5. **Resolve paths against the repo root containing the file**, which may be a
   worktree.
6. **Every hook adds latency** to every matched call. Measure it, and record the
   measurement with its date.

## `.claude/settings.json`

The file is `.claude/settings.json`, shipped by base. Its sections:
`attribution` (the commit trailer `commit-msg` checks); `permissions`
(`allow`, `ask`, and a `deny` list covering the secret files, the CLI token
stores, `gh pr merge`, pushes to `dev`, `staging` and `main`, `--no-verify`
and force-pushes, while the `*.example` files the agent maintains stay
readable); `hooks` (`PreToolUse` runs the guards and the two agent reviewers,
`SessionStart` runs `bootstrap`, `PostToolUse` runs `worktree-trace`: the
tables above); `enabledPlugins` (claude-security, which each person installs);
and `worktree.baseRef`, which only takes `fresh` (= `origin/main`) or `head`.
Neither names `dev`, which is why the base guard exists.
