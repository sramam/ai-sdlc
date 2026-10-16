---
name: ci-cd-and-automation
description: Automates CI/CD pipeline setup. Use when setting up or modifying build and deployment pipelines. Use when you need to automate quality gates, configure test runners in CI, or establish deployment strategies.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/ci-cd-and-automation/SKILL.md
---

# CI/CD and Automation

Follow [the upstream skill](../../3rdparty/agent-skills/skills/ci-cd-and-automation/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

- **The CI is `pnpm ci:local`**, not GitHub Actions (turned off). It runs
  every step in `sdlc.config.json` (`ci.steps`) in a clean snapshot of the
  commit, on this machine, and posts the verdict as a `local-ci` commit
  status. It costs no hosted minutes, and an agent can run it as often as it
  likes. Add a quality gate by adding a step there, not a workflow file.
- **`pnpm land` runs it** before every merge to `dev`, and again on the merge
  commit; promotion requires a green `local-ci` status on the exact SHA.
- **Deployment** is `pnpm promote:staging` / `pnpm promote:prod` (module
  `promote`): fast-forward only, migrate before deploy, smoke after. Preview
  environments are optional (`docs/kit/environments.md`).
