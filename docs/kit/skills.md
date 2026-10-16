# Skills

A skill holds the procedure and the remembering, not the judgement. The
workflow's skills are Addy Osmani's
[agent-skills](https://github.com/addyosmani/agent-skills), which encode how a
senior engineer specifies, plans, builds, tests, reviews and ships. This
project's own knowledge (personas and journeys, the plan in the repository,
worktrees, `pnpm land`, the threat model) is added to them as amendments,
each kept only because it changes what an agent does here.

## Where they live

| path                             | what                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `.agents/3rdparty/<source>/`     | third-party skills, verbatim, at the commit in `SOURCE.json`. Never edited here; agents never load them directly              |
| `.agents/skills/<name>/SKILL.md` | what agents load: a wrapper per upstream skill or command (its description, a link to it, the amendments), and our own skills |
| `.agents/skills/<name>/*.md`     | procedures an amendment points to (`landing.md`, `handoff.md`, `requirements.md`, …)                                          |
| `.claude/skills/<name>`          | symlinks to `.agents/skills/<name>`, so Claude Code sees them; created by the CLI and `pnpm bootstrap`                        |
| `.claude/agents/<name>.md`       | the personas `/ship` fans out to (code reviewer, security auditor, test engineer, web performance), wrapping upstream's       |

The checks on the copies and the sync are in [registry.md](registry.md)
§ _Third-party skills_.

## The workflow (base)

People type two commands, `/kickoff` and `/spec`; the pipeline invokes the rest.

| phase    | command                                            | skills it applies (amendments in their wrappers)                                                                                                                                                                                                                              |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEFINE   | **`/kickoff`** (ours), then `/spec` per change     | `kickoff` (people, product, personas and journeys, stack, architecture; restartable), `interview-me`, `idea-refine`, `spec-driven-development`, `source-driven-development`                                                                                                   |
| PLAN     | `/plan`                                            | `planning-and-task-breakdown`: `docs/plan/items/`, platform `X-` items first, features by journey, status from git                                                                                                                                                            |
| BUILD    | `/build`, `/build auto`                            | `incremental-implementation`, `test-driven-development`, `api-and-interface-design`, `frontend-ui-engineering`, `doubt-driven-development`, `context-engineering`                                                                                                             |
| VERIFY   | `/test`                                            | `test-driven-development` (a real database, never a fake), `browser-testing-with-devtools`, `debugging-and-error-recovery`, `journeys` (module)                                                                                                                               |
| REVIEW   | `/review`, `/code-simplify`; hooks on every commit | `code-review-and-quality` (+ seven project criteria), `code-simplification`, `security-and-hardening` (+ threat-model review, claude-security), `performance-optimization`, `humanizer` (prose; the mechanical tells are caught earlier by the prose pattern check, hooks.md) |
| SHIP     | `pnpm land` per item; `/ship` per release          | `git-workflow-and-versioning` (claim, worktree, trailers, `pnpm land`, `pnpm release`), `ci-cd-and-automation` (`ci:local`), `shipping-and-launch`, `deprecation-and-migration`, `observability-and-instrumentation`, `documentation-and-adrs`                                |
| CONTINUE | `pnpm bootstrap` (ours, at session start)          | `context-engineering` (handoff, pickup, the context checklist), `progress-report` (ours, with AI cost from `pnpm usage`)                                                                                                                                                      |

`/constraints` and `/webperf` are upstream's too. The router is
`using-agent-skills`; its wrapper maps each phase to this project. `/review`
replaces Claude Code's built-in command of that name inside a project.

## Optional skills (`pnpm sdlc add <name>`)

| item                    | source                  | add it when                                                                                                      |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `stripe-best-practices` | stripe/ai               | the project takes payments, subscriptions or tax through Stripe                                                  |
| `scroll-craft`          | nateherkai/scroll-craft | a marketing or landing page has to stand out (needs Playwright and ffmpeg; paid image generation through kie.ai) |

Referenced, not copied (install them yourself when the work calls for it):

| skill           | install                                                                                                              | add it when                                                           | note                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| claude-security | declared in `.claude/settings.json`; `claude plugin install claude-security@claude-plugins-official --scope project` | always (base declares it)                                             | its license forbids redistribution, so each person installs it       |
| OpenSEO         | `npx skills add every-app/open-seo` and its MCP server                                                               | SEO, keyword or AI-visibility research for a public site              | a paid OpenSEO account; its skills write to a remote project context |
| HyperFrames     | `npx skills add heygen-com/hyperframes`                                                                              | the project produces video (a launch video, a PR explainer, captions) | sends render feedback to a public channel unless telemetry is off    |

## Writing skills well

Everything an agent reads is held to the five context tenets (clarity,
actionability, fidelity, efficiency, security: [principles.md](principles.md)
§ 0), with the checklist in
`.agents/skills/context-engineering/context-quality.md`. In practice:

- **Amend; do not fork.** A difference from upstream goes in the wrapper,
  beside the text it changes, and only if it changes what an agent does here.
  Editing the copy breaks the next sync.
- **The skill text is read by an agent mid-task.** Lead with the steps; put the
  reasons after them, briefly.
- **Name what the skill may not decide.** For example, `pnpm land` may not merge
  red, may not decide a failure is "unrelated", and may not release to QA.
- **End by printing the next step**, so the instruction travels with the
  output.
- **The count of criteria in the header must equal the number of sections.**
  A criterion the header does not count goes unreported. Put a pattern check
  on your own skills.

## Tools not documented elsewhere

- `gh api` for anything compared; `--json` is fine for reading. Prefer `gh`
  and the REST/GraphQL API to an MCP connector for scripted work, because a
  connector's quota is shared by every agent.
- A capture outbox for email in dev and e2e, written to disk with an index.
- **`pnpm dev:session`** (the `dev-session` recipe): completes a real
  passwordless sign-in for a seeded account and writes a cookie jar, so agents
  can `curl` authenticated pages. It refuses production and refuses when the
  target is ambiguous.
