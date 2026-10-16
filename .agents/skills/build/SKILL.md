---
name: build
description: Implement tasks incrementally — build, test, verify, commit. Add "auto" to run the whole plan in one approved pass.
metadata:
  upstream: .agents/3rdparty/agent-skills/.claude/commands/build.md
---

# /build

Follow [the upstream command](../../3rdparty/agent-skills/.claude/commands/build.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

`/build` is the pipeline. The spec was the only human gate
(`using-agent-skills`); from here nothing waits for one, except where the stop
rules below say so.

### `/build`: the next ready item

1. **Pick and claim**: `pnpm plan:status --ready`, then claim it and create its
   worktree (`git-workflow-and-versioning` § _Starting an item_). There is no
   `tasks/todo.md` and no "next pending task": the plan's ready set is the
   queue.
2. **Build it in slices**, upstream's loop per slice (RED → GREEN → full suite →
   build → commit), each commit with `Progress: <ID> …`. Nothing is ticked
   off; there is no task status to update.
3. **Finish**: the last commit carries `Closes: <ID>`. Run `/review`; fix what
   it finds. For a change in `security-and-hardening`'s scope, run its review
   too.
4. **Land**: `pnpm land` in the background; act on its result when it arrives.
   Red is a stop, never "unrelated".
5. **Journeys** _(module)_: `pnpm plan:status --journeys`; for a journey whose
   items are now all done, run `/journeys add` and `/journeys test`.

### `/build auto`: every ready item

Upstream's autonomous mode, with these differences:

- **The spec check is `pnpm plan:check`**, not a `SPEC.md` file: it refuses
  items whose feature has no `Approved:` line.
- **No plan checkpoint.** If approved features have no items yet, plan them
  (`planning-and-task-breakdown`) and land the plan, then continue.
- **The unit is the item, not the task**: claim → slices → review → land, one
  worktree at a time, then `pnpm plan:status --ready` again, until nothing is
  ready. Close each landed worktree before claiming the next.
- Stop and ask where upstream says (a failure without an obvious fix, an
  ambiguity, anything high-risk or irreversible), and also when: `pnpm land`
  is red, the item needs a requirement changed (that is `/spec`, and a person
  approves it), or a technology decision is open.
- **When it stops or finishes**, write the handoff
  ([context-engineering/handoff.md](../context-engineering/handoff.md)) and
  report what landed, what is ready next, and what is blocked on whom.
