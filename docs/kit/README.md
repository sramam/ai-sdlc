# ai-sdlc — the kit

An agent-driven SDLC, distilled.

These notes were distilled from an earlier project where several people and
many concurrent agent sessions worked in one repository; nothing here is
specific to its domain. They are written to be **handed to an agent setting up
a new repository**, and to the people who will work alongside it.

## How to use this

A new project **is created with `ai-sdlc init`** from the registry
([registry.md](registry.md)), which copies base: this kit, its tooling, skills
and hooks, and no product code. Modules and recipes arrive later with
`pnpm sdlc add`, and the project owns every file it was given. Then give the
agent one instruction:

> Read `docs/kit/BOOTSTRAP.md` and follow it. Start with `/kickoff`.

This kit lives in the registry (`ai-sdlc`) at `docs/kit/`, and every project
gets a copy. It is both the registry's specification and its documentation.

Every later request goes through `/spec`, and a new persona or product area
through `/kickoff revisit product`; nothing else changes requirements.

The other files are what the bootstrap points at.

| file                                                                  | for                                  | read when                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| [BOOTSTRAP.md](BOOTSTRAP.md)                                          | the setup agent                      | first, and in order                                                                                                      |
| [principles.md](principles.md)                                        | everyone                             | before writing any guard, check, test or doc                                                                             |
| [AGENTS.template.md](AGENTS.template.md)                              | the setup agent                      | to write the new repo's root `AGENTS.md` / `CLAUDE.md`                                                                   |
| [sdlc.md](sdlc.md)                                                    | everyone                             | how work moves from a request to production                                                                              |
| [ux.md](ux.md)                                                        | everyone building UI                 | the UX questions `/kickoff` asks, the shadcn defaults, the screen patterns, the traps                                    |
| [data-model.md](data-model.md)                                        | everyone touching data               | discovering the domain model; designing it for simplicity and efficiency                                                 |
| [environments.md](environments.md)                                    | the setup agent                      | local, dev, staging, production, and the rules between them                                                              |
| [ai.md](ai.md)                                                        | everyone                             | AI designed in from discovery: act, assist, see, notice, AI-prompted onboarding, and the architecture that makes it safe |
| [technology-decisions.md](technology-decisions.md)                    | everyone                             | the triggers that need a technology decision, and the pros-and-cons dialog the user decides through                      |
| [memory.md](memory.md)                                                | everyone                             | what the project remembers, where, and how lessons reach other projects                                                  |
| [registry.md](registry.md)                                            | everyone                             | base and items, `pnpm sdlc add`, `diff` and `update`, the lock, `scripts/` vs `scripts/one-of/`                          |
| [plan-and-requirements.md](plan-and-requirements.md)                  | everyone                             | where personas, features, requirements, the plan and questions live, their IDs, and the pattern check over them          |
| [multi-agent.md](multi-agent.md)                                      | anyone running more than one session | before the second agent starts                                                                                           |
| [testing.md](testing.md)                                              | everyone                             | before the first test touches a database or a browser                                                                    |
| [tech-stack.md](tech-stack.md)                                        | the setup agent                      | TanStack Start on Cloudflare: what is settled, what to decide, and the Workers constraints                               |
| [security.md](security.md)                                            | everyone                             | the highest threat model, Oso or SpiceDB, OpenRouter and vast.ai under it, the baseline controls                         |
| [observability.md](observability.md)                                  | everyone                             | OpenTelemetry from the first commit: span conventions, privacy, Workers                                                  |
| [hooks.md](hooks.md)                                                  | the setup agent                      | wiring git hooks and Claude Code hooks                                                                                   |
| [recipes/](recipes/)                                                  | the setup agent                      | reference packages the foundation items add with `pnpm sdlc add`                                                         |
| [skills.md](skills.md) and [`.agents/skills/`](../../.agents/skills/) | the setup agent                      | the skills base and the modules ship, and those added later                                                              |
| [what-did-not-work.md](what-did-not-work.md)                          | everyone                             | the expensive mistakes, so they are not repeated                                                                         |

## The one-paragraph version

Several agents working in one repository will drift from every convention that
nothing enforces. So every convention is **enforced mechanically**: a hook that
catches it in seconds, plus a merge gate that is the authority. Here the merge
gate is **local CI**, with its verdict posted as a commit status, because hosted
CI gets expensive fast. A blocked agent **asks, records the question and keeps
working**; it never idles. Every list that
matters is **counted by a test** (a "pattern check") instead of maintained by hand. Every
check has **three answers** (yes, no, _could not ask_), and the third is
handled on purpose. Each agent works in its **own git worktree**, forked from
the integration branch. Commits carry a `Progress:` block, so `git log` alone can
reconstruct what happened. Every change advances a plan item that traces to a
requirement, a persona and a journey. Pull requests are
merged with **merge commits**, never squashed. The root agent file stays
**short and static**; a rule file that grows into a history book is the most
expensive habit a project can have.
