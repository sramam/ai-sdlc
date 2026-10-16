# AI in the product — designed in from discovery

**Every application asks how AI can be deeply integrated into it.** Not a chat
box bolted on at the end, but part of how people do things, see things and set
things up. `/kickoff` asks the questions below for every persona and journey in
stage 2 (the product), and settles the architecture that follows in stage 3. Where AI does not earn its
place, the answer is recorded as "no", with the reason.

## What kickoff asks (BRD theme 11, and per feature in the checklist)

**1. Actions: can AI do the work?** For each journey: which steps are tedious,
repetitive, or need judgement over a lot of data? Could an agent perform them
on the user's behalf?

- fully (the agent acts, the user is told)
- proposed (the agent drafts, the user approves with one click)
- or never (it is consequential, regulated, or the user wants control)

Name the consequential actions, which always need a person's approval: money,
legal notices, deletion, anything sent to a third party.

**2. Assistance: can AI help a person do it?** Drafting messages and
documents, summarising a record's history, extracting data from uploads
(invoices, IDs, spreadsheets), classifying and routing incoming items, filling
forms from context, explaining an error or a refusal in plain words.

**3. Seeing: dashboards and BI.**

- Which questions does each persona ask of their data?
- Can they ask in plain language and get a number, a table or a chart back?
- Should the dashboard explain itself ("why did collections drop this week?")
  and flag anomalies before anyone asks?
- What must never be answered: other tenants' data, or fields their role
  cannot see?

**4. Proactive: can it notice things?** Recommendations, risk flags, reminders,
and "you usually do X now", each with the threshold that makes it useful rather
than noisy.

**5. Setup: does the product need customising per customer or user?** If so, use
**AI-prompted onboarding**: a conversation that interviews the new customer and
configures the product, instead of a wall of settings (see below).

**6. Limits and trust.**

- Which data classes may reach a model (`security.md`)?
- What accuracy is acceptable for each use, and how will we measure it?
- What is the cost ceiling, per run and per tenant per day? What monthly budget
  does that add up to?
- Where must the UI show that AI was involved, and let the user correct it?

The answers go into the requirements: AI-specific requirements per feature,
journeys that include the AI paths, and a `## AI` section in `prd.md` listing
every AI capability, its mode (act, propose, assist, see, notice, set up), its
data class, its evaluation and its cost cap.

## AI-prompted onboarding

When a product needs per-customer configuration (workflows, categories, roles,
templates, rules, branding), the default onboarding is **a conversation, not a
form**.

- **It interviews, then proposes.** "Tell me how your team works" leads to a
  proposed configuration the user can see, edit and accept. It is the same
  shape as `/kickoff`, aimed at the product's own users.
- **It writes a draft, never live settings.** The draft is applied in one
  explicit step, with a preview of what will change. An abandoned onboarding
  leaves nothing half-configured.
- **It is resumable and non-destructive.** It asks only what is still open,
  and never overwrites something the user set by hand.
- **It uses the same capabilities as the settings screens**, with the user's
  authority. Every setting it can change is also changeable by hand, so AI is a
  faster path, never the only one.
- **It imports.** Users can upload what they already have (a spreadsheet, a
  policy document, an export from the old system), and AI extracts a proposal
  from it.
- **It is evaluated** like any other AI feature, against recorded sample
  onboardings and their expected configurations.

## Architecture (settled in `/kickoff`, topic 12)

The architecture makes this cheap: **one port, many bindings.** Every capability is implemented once, so AI is just another binding.
Every project gets three by default, rendered from the capability manifest: a
typed **SDK**, an **HTTP API** with an OpenAPI document, and an **MCP server**
([`recipes/api-bindings`](recipes/api-bindings/)). A capability missing from
one needs a declared exclusion with a reason, and a pattern check enforces it.

| need                           | how                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| agents performing actions      | an **agent binding** over the capability manifest. A tool _is_ a capability, so an agent can do nothing a capability cannot. Its authority is the **caller's permissions ∩ the agent's declared scope**, and activating an agent requires holding every permission in that scope                 |
| external agents and assistants | the **MCP binding** every project has: one tool per capability, OAuth 2.1 per the MCP authorization spec, and exactly the caller's authority, narrowed by the token's scope                                                                                                                      |
| consequential actions          | **propose, then approve**: the agent writes a proposal, a person approves it, and the capability runs with that person's authority. A hold window, during which a person can cancel, suits time-sensitive automation                                                                             |
| plain-language BI              | a **semantic layer**: named metrics and dimensions defined in code, executed through scoped capabilities. The model chooses _which_ metric, filter and grouping; **it never writes SQL against the database.** Row scope and field visibility therefore come from the access model automatically |
| charts and explanations        | the model returns a structured chart spec, validated by Zod and rendered by our chart components, plus an explanation that cites the numbers it used                                                                                                                                             |
| extraction and drafting        | structured outputs validated by Zod; low-confidence fields are flagged for a person, not silently filled                                                                                                                                                                                         |
| proactive insights             | scheduled jobs (Cron or Queues) computing signals; the model only phrases and ranks them                                                                                                                                                                                                         |
| onboarding                     | a draft entity with a lifecycle (state machine), filled by the conversation and applied by a capability                                                                                                                                                                                          |

**Every AI run is recorded**: the agent, the caller and activator, the tools
called, tokens, cost, the outcome, and the approvals. The record is append-only,
and each run is a trace in OTel. A run whose pricing came from a guess is
marked as estimated, not silently under-counted. The run log is to build: it
lives in `@<scope>/llm` and arrives with the first AI feature; the
`llm-openrouter` recipe ships the cost ledger (`src/budget.ts`) it will write
to, not the log.

## Building AI features

- **Model access through `@<scope>/llm` (OpenRouter)**, which enforces the
  routing the data class requires, the cost caps, and the rule that model
  output is untrusted input ([security.md](security.md) § _Model providers_).
- **Model per role, configured**: a cheap model for classification, a strong one
  for reasoning. Never hard-coded. Automatic fallback to a different model is
  off, because a weaker model answering silently is a failure, not resilience.
- **Prompts are code, held to the context checklist**
  (`.agents/skills/context-engineering/context-quality.md`, § _Prompt
  structure_): the static part (role, rules, tool descriptions, examples) first
  and byte-identical between calls so it is cached; the call's data next,
  delimited and labelled; the task last; the output's shape specified. Each
  lives in one file beside its eval, and the code review checks it like any
  other change.
- **Prompt injection is assumed.** Content the model reads (uploads, emails,
  records written by other users) can carry instructions. Tools enforce
  authority regardless of what the model was told, and consequential actions
  need approval.
- **A cost cap counts in the unit OpenRouter reports.** What the
  `llm-openrouter` recipe assumes about that unit, and what to check against
  the account, is in [its README](recipes/llm-openrouter/README.md).
- **Recordings hold synthetic data only**, never a real user's prompt.
- **Tests never call a model.** Recorded responses replay in tests. Re-record
  when a prompt changes.
- **Evals are separate**, each with a pass threshold, a set of cases (including
  adversarial and injection cases), and a run against the production model
  before release. An AI feature with no eval is not done.
- **The UI shows AI honestly**: what it did, what it proposes, how sure it is,
  how to undo it, and a way to correct it. Corrections feed the eval set.
