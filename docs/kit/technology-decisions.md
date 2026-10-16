# Technology decisions: an informed choice, made by the user

The settled stack ([tech-stack.md](tech-stack.md)) covers what every project
needs. Requirements regularly call for more: real-time updates, search, maps,
payments, video, offline use, a mobile app, ML on GPUs. The agent never picks
one of these silently. It names the need, lays out the options honestly,
recommends one, and the user decides. The decision becomes an ADR that the
architecture cites.

## When a decision is triggered

`/kickoff` and `/spec` each scan the requirements for these
triggers. A trigger found with no decision behind it is blocking for the
items that depend on it. `plan:check` enforces it at the requirements stage:
every trigger in `docs/requirements/technology.md` is decided, citing an ADR,
or pending, citing its requirement IDs (`tooling/plan/src/plan-check.mts`).

| the requirement says or implies                               | the decision                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| live updates, presence, collaboration, chat                   | real-time transport (Durable Objects with WebSockets, SSE, a hosted service) |
| search across text, fuzzy matching, facets                    | Postgres full-text, a search engine, or a hosted search service              |
| files beyond simple uploads: previews, transformations, video | processing pipeline, storage tiers, a media service                          |
| payments, subscriptions, payouts, invoicing                   | payment provider and account shape                                           |
| maps, addresses, geolocation, distance                        | geocoding and map provider, and address validation                           |
| scheduled or long work: imports, reports, sync                | Queues, Workflows or Cron design, and idempotency                            |
| notifications: email, SMS, push, in-app                       | providers per channel, consent model                                         |
| mobile, offline, installable                                  | native, PWA or a cross-platform framework; sync strategy                     |
| AI features: generation, extraction, agents, embeddings       | models and routes, a vector store, evals, cost caps                          |
| ML training or batch inference                                | GPU source and data class (the vast.ai rules)                                |
| reporting, analytics, exports at volume                       | an OLAP store or warehouse vs Postgres, export formats                       |
| integrations with named external systems                      | the integration pattern: webhooks, polling, iPaaS                            |
| identity: SSO, SCIM, enterprise login                         | identity provider capabilities                                               |
| compliance: HIPAA, PCI, SOC 2, residency                      | hosting regions, vendors with the right attestations                         |
| an app or surface beyond the main web app                     | a new app in the monorepo, and how it shares the port                        |

Unlisted triggers count too. Any requirement the settled stack cannot meet
cleanly is a trigger.

## The dialog

Run it as a conversation, not a report. Each step is shown to the user before
the next one starts.

**1. Frame the need.** Restate the requirement IDs behind it, the volumes (users,
data, requests, and growth), the latency or freshness needed, the data class
(which constrains vendors under the threat model), and the budget. Ask what is
missing before going further.

**2. List the options**, usually two to four. Always include:

- the option that uses the settled stack alone, even if it is weaker, to
  show what the extra technology buys
- a managed service and a build or self-host option where both are real
- **"not now"**: what the product looks like if we defer, and what that costs

**3. Compare them on the same criteria**, in one table, with sources:

| criterion            | the question                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| fit                  | does it meet the requirement IDs fully, or partly (say which part)?                                |
| security and data    | where does data go, what is retained, which attestations does it hold? Does it pass `security.md`? |
| runtime fit          | does it work from Cloudflare Workers? Through what (HTTP, a binding, a sidecar)?                   |
| cost                 | at launch volume and at 10×, including the pricing cliffs                                          |
| operational burden   | what we run, monitor, upgrade and get paged for                                                    |
| lock-in and exit     | how hard is it to leave, and is data export possible?                                              |
| maturity             | release cadence, maintenance, community, the vendor's health                                       |
| developer experience | SDK quality, local development, testability (can tests run without the network?)                   |
| licence              | does it permit our use, and what changes if we self-host?                                          |

**Evidence, not memory.** Every claim about a vendor, especially pricing,
limits, retention and Workers compatibility, is checked against current
documentation in this session, with a link and the date read. Where docs cannot
settle it, say "unknown" and propose a spike: a time-boxed probe that
answers the specific question.

**4. Recommend, with confidence and reasons.** "I recommend B, with medium
confidence, because of X and Y. It would be the wrong choice if Z." Name what
would change the recommendation.

**5. The user decides.** Present the options with the recommendation first, and
ask. Do not proceed on the recommendation by default. If the user wants more,
answer the follow-up, run the spike, or bring in a second opinion. While the
decision is open, carry on with work that does not depend on it (principles.md
§15).

**6. Record it.** During discovery, `/kickoff` records the trigger in stage 2
and runs this dialog in stage 3; after discovery, `/spec` runs it. Either way, add
the trigger, its requirement IDs and the ADR to
`docs/requirements/technology.md`, and write an ADR with the context (requirement IDs), the options
compared (the table), the decision and who made it, the rejected options and
why, the consequences, and a revisit trigger ("revisit if monthly volume
exceeds N" or "if the vendor changes its retention policy"). Then update:

- `docs/architecture.md`: the component, citing the ADR
- the plan: items for the integration package, its port (if the vendor may
  change), its pattern check and its spans

## What the agent must not do

- choose a technology because it is familiar, popular or already half-installed
- hide a cost, a retention policy or a Workers incompatibility it found
