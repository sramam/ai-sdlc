---
name: shipping-and-launch
description: Prepares production launches. Use when preparing to deploy to production, or when asking what needs to be in place before shipping. Use when you need a pre-launch checklist, when setting up monitoring, when planning a staged rollout, or when you need a rollback strategy.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/shipping-and-launch/SKILL.md
---

# Shipping and Launch

Follow [the upstream skill](../../3rdparty/agent-skills/skills/shipping-and-launch/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- **`/ship` decides; promotion deploys.** After a GO: `pnpm release` names
  the commit, `pnpm promote:staging` deploys it, the journeys a person signs
  off go to QA (`/journeys ready-for-qa`), and `pnpm promote:prod` follows.
  All four are in the `promote` and `journeys` modules.
- **Staged rollout** is that sequence; feature flags are upstream's, when the
  project decided to use them.
- **The rollback plan** names `pnpm rollback <env>`: it moves code back and
  leaves the schema forward, so a migration in the release must be additive
  (`deprecation-and-migration`).
