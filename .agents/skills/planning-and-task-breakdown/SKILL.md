---
name: planning-and-task-breakdown
description: Breaks work into ordered tasks. Use when you have a spec or clear requirements and need to break work into implementable tasks. Use when a task feels too large to start, when you need to estimate scope, or when parallel work is possible.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/planning-and-task-breakdown/SKILL.md
---

# Planning and Task Breakdown

Follow [the upstream skill](../../3rdparty/agent-skills/skills/planning-and-task-breakdown/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

### The task list target is `docs/plan/`

This project designates its own target, as upstream allows: no `tasks/plan.md`,
no `tasks/todo.md`, no GitHub Issues or Projects (they are turned off).

- **One file per task** in `docs/plan/items/<ID>-<slug>.md`, with front matter
  `id`, `title`, `requirements`, `personas`, `journeys`, `milestone`,
  `depends`, `estimate` (upstream's XS–L, or `unknown`; an XL is split). Its
  body is upstream's task structure: acceptance criteria copied from the
  requirement and made concrete, verification, files likely touched.
- **The plan document** is `docs/plan/README.md`: milestones (each with the
  journeys it completes), a mermaid dependency graph, the critical path, the
  assumptions, what was deferred, and a change log that is only appended to.
- **Status is never written down.** No checkboxes, no `status:` field. An item
  is claimed when a remote branch carries its ID, and done when a commit on
  `origin/dev` closes it (`Closes: <ID>`). `pnpm plan:status` derives it. This is what
  lets several agents work one plan without overwriting each other, so
  upstream's "never overwrite an incomplete plan" holds by construction.
- **Checkpoints** are milestones and `depends:` edges, not checklist rows.
- IDs (`docs/kit/plan-and-requirements.md`) are never renumbered or reused. A
  task no longer wanted gets `dropped: <reason>`, the only decision an item
  records.

### Slice by journey; platform first

Upstream's vertical slices are cut along journeys here: a half-built journey is
worth nothing.

1. **Platform items first**, as `X-<nnn>`, in the order in
   `docs/kit/BOOTSTRAP.md` Phase 3: the platform spike, the apps and packages
   from recipes and the modules kickoff listed (`pnpm sdlc add …`),
   infrastructure, environments and promotion, security baseline, telemetry,
   UI foundation, test harness. These are what make the system work at all;
   each names the guards it must trip.
2. **Then features, ordered by journey.** Each milestone completes one or more
   whole journeys (`J<nn>`), end to end, for every persona in them. Seeds and
   authorization cells for an entity arrive with the item that creates it.

Refuse to plan when `review.md`'s verdict is not `ready-to-plan` or
`ready-with-assumptions`, when the brief's _Blocking_ list is not empty, or
for a feature with no `Approved:` line, unless a person overrides it in
writing.

### Check, then hand over

Run `pnpm plan:check --stage plan` and fix every finding. Land the plan with
`Closes: X-000` on its first landing. There is no second approval: the spec was
the gate, and `/build auto` starts from here.

### Re-planning (`/plan sync`, on the cadence in `sdlc.config.json`)

- Discovered work becomes new items, each placed in a milestone or dropped
  with a reason. A new _requirement_ goes through `spec-driven-development`.
- Answered `Q-` files: write the answer in, unblock what it blocked, and write
  an ADR if it shapes the system.
- A claimed branch with no commit for `claimStaleDays` is reported; ask its
  session or the author before releasing it.
- Re-derive the critical path; a slipped milestone goes in the change log.
- Run `pnpm plan:check`.
