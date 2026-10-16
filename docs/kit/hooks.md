# Hooks, trailers and guards

Everything here ships in the starter (`.husky/`, `tooling/guards/`,
`.claude/settings.json`). A project configures it through `sdlc.config.ts` and
never edits it in place.

## Commit trailers — the one grammar

Every other document refers here. Each trailer is a single line, parsed with
`git interpret-trailers --parse`, so prose that quotes a trailer is ignored.

| trailer                  | form                                                | rule                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Progress:`              | `Progress: <ITEM-ID> <free text: covered; remains>` | the ID is the first token, matched case-insensitively against `docs/plan/items/`. At least one commit on a branch carries it, unless `No-Item:` does                      |
| `Closes:`                | `Closes: <ITEM-ID>`                                 | only on the commit that finishes the item; once on `origin/dev`, the item reads _done_                                                                                    |
| `No-Item:`               | `No-Item: <reason>`                                 | for work that genuinely has no item (a revert, a dependency bump, a progress report). A commit trailer, not a PR-body line, so `ci:local` can check it before a PR exists |
| `Requirements:`          | `Requirements: kickoff\|idea\|add-requirement`      | required on any commit touching `docs/requirements/`                                                                                                                      |
| `Assumes:`               | `Assumes: Q-<nnn> → <option>`                       | building on an open question                                                                                                                                              |
| `No-Rerecord:`           | `No-Rerecord: J<nn> <reason>`                       | a route change that deliberately does not re-record a journey that visits it                                                                                              |
| `Co-Authored-By:`        | exactly `attribution.commit` from settings          | no model name                                                                                                                                                             |
| `Worktree:` / `Session:` | added by `prepare-commit-msg`                       | provenance                                                                                                                                                                |

## Git hooks (husky)

| hook                 | does                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit`         | `lint-staged`: lint, format, regenerate every generated artifact the staged files can change, and re-stage it. lint-staged appends filenames to the command, so wrap generators as `sh -c '…'`                                                                                                                                                                                                                                                             |
| `prepare-commit-msg` | appends `Worktree:` / `Session:` in a worktree (deduplicated on amend)                                                                                                                                                                                                                                                                                                                                                                                     |
| `commit-msg`         | enforces the trailer table above. It refuses a `docs/requirements/` change without `Requirements:`, which backstops writes the lock cannot see (`sed -i`). It refuses a `Progress:` or `Closes:` naming a missing item, and an attribution trailer that differs from settings. It **warns** when an upstream-owned path (`upstreamPaths()` in `tooling/core`: `tooling/<module>/` unless replaced, `docs/kit/`, `.claude/skills/<starter skill>/`) changes |
| `pre-push`           | refuses a push to `dev`, `staging` or `main`, except the named promotions run by the promote scripts. `sdlc:init` creates `dev` through the GitHub API, so it never pushes it                                                                                                                                                                                                                                                                              |

## Claude Code guards (`type: command`)

Each runs as **`node tooling/guards/src/<name>.mts`**: Node 24 strips the types, and
no `node_modules` is needed. Under `pnpm exec tsx` they all failed open in fresh
worktrees, which is exactly when they mattered.

| event                            | script              | does                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PreToolUse `Edit\|Write`         | `requirements-lock` | refuses writes under `docs/requirements/` unless `.claude/requirements-session` (gitignored, in **this** checkout) names this session and one of `kickoff`, `idea` or `add-requirement`; refuses **every** write under `docs/requirements/sources/` |
| PreToolUse `Edit\|Write\|Bash`   | `worktree-required` | refuses writes and `git commit` in the main checkout (`--git-dir` equal to `--git-common-dir`). **Exempt path: `docs/handoffs/`**, so `/handoff` can write there. A session exemption is a file keyed by `$CLAUDE_CODE_SESSION_ID`                  |
| PreToolUse `Bash\|EnterWorktree` | `worktree-base`     | `git worktree add` must base on `origin/dev`. `EnterWorktree({name})` is refused because it cannot name a base; `{path}` is allowed                                                                                                                 |
| PreToolUse `Bash\|EnterWorktree` | `worktree-single`   | one _live_ worktree per session (this session's records intersected with `git worktree list`)                                                                                                                                                       |
| PostToolUse                      | `worktree-trace`    | records created and entered events in the registry. Never fails a tool call                                                                                                                                                                         |

**The requirements lock marks who is authoring in this checkout. It does not
lock across agents.** Concurrency is handled by branches: a requirements change
lands on its own branch and PR, **before** the code that depends on it. A skill
that finds another unmerged branch changing `docs/requirements/` (`git log
origin/dev..origin/<branch> -- docs/requirements` over the remote branches)
says so, and works on something else until that branch lands.

**One shared git-command parser** (`git-command.mts`) is used by every guard.
door_nexa's guards separately missed `git -C <path>`, quoted paths and
`--work-tree`. The parser computes _where git would actually act_, rather than
reading the session's cwd.

**Known gaps, stated rather than implied away:**

- Bash commands that write files (`sed -i`, heredocs) are not gated. `git commit`
  and `commit-msg` are the backstop.
- Harness-created subagent worktrees bypass PreToolUse.
- Guards scan whole command text, so a command whose body _discusses_ a guarded
  command is refused. Use `--body-file` and `git commit -F`.

**Every override is a comment on the command line**
(`# worktree-base: <reason>`), so the reason survives into the transcript.

## Agent reviewers (`type: agent`)

`commit-reviewer` and `code-reviewer` run on `git commit`. `doc-validator` and
`monorepo-validator` run on markdown and manifest edits, once a project adds
them. What door_nexa learned:

1. **Fail open, and settle that before using any tool.** A reviewer with no
   tools, or handed a path outside the repo, approves. It cannot have found a
   defect in something it did not see.
2. **Block only through an exact sentinel line** (`BLOCK: <defect>`). An approval
   is one line and nothing else. Prose mentioning a dismissed concern got
   blocked by its tone.
3. **Block only on concrete defects.** Style is advisory, and so is a criterion
   that does not apply to the change (`n/a`).
4. **Never judge which model wrote something.** It cannot be observed.
5. **Resolve paths against the repo root containing the file**, which may be a
   worktree.
6. **Every hook adds latency** to every matched call. Measure it, and record the
   measurement with its date.

## Template (`.claude/settings.json`, shipped in the starter)

```jsonc
{
  "attribution": { "commit": "Co-Authored-By: Claude <noreply@anthropic.com>" },
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(gh:*)",
      "Bash(pnpm *)",
      "Read(**/.env.example)",
      "Edit(**/.env.example)",
      "Read(**/.dev.vars.example)",
      "Edit(**/.dev.vars.example)",
    ],
    "ask": ["Bash(git rm:*)"],
    "deny": [
      "Read(**/.env)",
      "Read(**/.env.local)",
      "Read(**/.env.*.local)",
      "Edit(**/.env)",
      "Edit(**/.env.local)",
      "Read(**/.dev.vars)",
      "Edit(**/.dev.vars)",
      "Read(~/.wrangler/**)",
      "Read(~/.config/gh/**)",
      "Read(~/.ssh/**)",
    ],
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node tooling/guards/src/requirements-lock.mts",
            "timeout": 15,
          },
        ],
      },
      {
        "matcher": "Bash|EnterWorktree",
        "hooks": [
          {
            "type": "command",
            "command": "node tooling/guards/src/worktree-base.mts",
            "timeout": 15,
          },
          {
            "type": "command",
            "command": "node tooling/guards/src/worktree-single.mts",
            "timeout": 15,
          },
        ],
      },
      {
        "matcher": "Edit|Write|NotebookEdit|MultiEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node tooling/guards/src/worktree-required.mts",
            "timeout": 15,
          },
        ],
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "agent",
            "if": "Bash(git commit *)",
            "timeout": 120,
            "prompt": "<commit-reviewer: fail open; one-line approval; BLOCK: sentinel>",
          },
          {
            "type": "agent",
            "if": "Bash(git commit *)",
            "timeout": 120,
            "prompt": "<code-reviewer: fail open; n/a criteria allowed; BLOCK: sentinel>",
          },
        ],
      },
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|EnterWorktree|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node tooling/guards/src/worktree-trace.mts",
            "timeout": 15,
          },
        ],
      },
    ],
  },
  "worktree": { "baseRef": "head" },
}
```

The deny list covers the secret files (`.env`, `.env.local`, `.dev.vars`) and
CLI token stores, while the `*.example` files the agent maintains stay
readable. `worktree.baseRef` only takes `fresh` (= `origin/main`) or `head`.
Neither names `dev`, which is why the base guard exists.
