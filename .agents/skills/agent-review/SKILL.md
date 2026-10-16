---
name: agent-review
description: Check agent work at the level the stakes require. Use it before relying on a delegated agent's result (Level 1), when exact values or completeness from source material matter (Level 2), and before a conclusion drives a consequential decision or is shared beyond the current session (Level 3). Level 1 makes the agent hand back a verifiable artifact or name its failure. Level 2 has two independent agents do the same job and checks every difference against the source. Level 3 is adversarial review, with a self-audit, cold persona reviewers, then fresh eyes. Its self-audit applies whenever a claim is stated as a conclusion.
metadata:
  upstream: .agents/3rdparty/agent-review/SKILL.md
---

# Agent review

Follow [the upstream skill](../../3rdparty/agent-review/SKILL.md) in full, with
the amendments below. Where they differ, the amendments win.

## Amendments

### Where each level sits in this project's pipeline

| level | when                                                                                | here                                                                                                                                                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | every delegation: a sub-agent that writes files, runs a sweep, or produces a report | the contract in `docs/kit/multi-agent.md` § _Long-running work goes to a sub-agent_ and § _A sweep across one tree_; the artifact is the files or the report, the check is the tree-wide command the lead runs afterwards                                                       |
| 2     | an extraction whose values must be right                                            | `/kickoff` importing a document into requirements (the importing step in [kickoff/product.md](../kickoff/product.md)); any measurement that goes into the kit as a fact                                                                                                         |
| 3     | before a conclusion drives a decision or leaves the session                         | `/ship` (the fresh-eyes round is the three personas, isolated as upstream requires); the threat-model review's confirm-before-report; `doubt-driven-development` for a decision in flight; a spec before a person approves it, only when the decision it drives is irreversible |

The self-audit (Stage 1 of Level 3) is always on: `AGENTS.md` carries it, and
the context checklist's fidelity section asks for it on every claim a reader
would act on.

### What this project already provides

- **The artifact of an item is its landed commit**, and the check is
  `local-ci` on that exact SHA (`pnpm land`). Level 1's hash and byte floor
  apply to what a sub-agent hands back inside an item, not to the item itself.
- **Isolation is instructed, not enforced, for a sub-agent in this session.**
  Upstream's tool notes say how to make it real (a `claude -p` session outside
  the repository, deny rules, no `name`, no `SendMessage`). Record which one a
  review used, as upstream asks; a review that only instructed isolation says
  so in its register.
- **`reviews/` is gitignored** at the project root, so review files that quote
  private sources never land. The findings register lives at
  `reviews/findings.md`; what travels with a shipped artifact is the note
  upstream describes, outside `reviews/`.
- **Severity words**: upstream's blocker, should-fix and minor map onto the
  threat-model review's critical and high (blocker), medium (should-fix) and
  low (minor) when the two reports sit side by side in a `/ship` decision.

### Not here

- Upstream sets `effort: high` and lets the model invoke the skill on its own.
  This wrapper carries neither: the pipeline names the level it wants, and a
  person asks for Level 3 by name.
- Searching other projects' history for failure patterns (upstream's
  _Learn from earlier failures_) means this project's own: `docs/handoffs/`,
  `docs/progress/`, `docs/kit/what-did-not-work.md` and the plan's `Q-` files.
  Never another repository's transcripts.
