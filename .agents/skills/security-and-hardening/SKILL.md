---
name: security-and-hardening
description: Hardens code against vulnerabilities. Use when auditing an input handler for vulnerabilities, when handling user input, authentication, data storage, or external integrations, or when checking a login flow is safe against the OWASP Top Ten. Use when building any feature that accepts untrusted data, manages user sessions, or interacts with third-party services. Use when auditing dependencies for known vulnerabilities, triaging package-manager audit findings, or assessing supply-chain risk in a new package. Use when personal data or privacy compliance (GDPR, CCPA) is involved.
metadata:
  upstream: .agents/3rdparty/agent-skills/skills/security-and-hardening/SKILL.md
---

# Security and Hardening

Follow [the upstream skill](../../3rdparty/agent-skills/skills/security-and-hardening/SKILL.md)
in full, with the amendments below. Where they differ, the amendments win.

## Amendments

Upstream is the generic layer (OWASP, validation, least privilege). This project
adds two more, because its stack has specific controls and an independent
scanner is worth more than a self-review.

### 1. The threat-model review _(module `security`)_

Once the `security` module is added, follow
[threat-model-review.md](threat-model-review.md) for any change to auth,
authorization, money, uploads, webhooks, model routing or secrets handling,
and before every release. It runs `pnpm security:scan` and walks the
adversaries and controls in `docs/kit/security.md`. Without the module, the
code review's access-safety criterion is the check.

### 2. Claude Security, as an independent scan

Anthropic's `claude-security` plugin scans a codebase or a diff and confirms
each finding through independent verifiers before reporting it. Its license
allows each user to install and run it, not to copy it into a repository, so
the project **declares** it (`.claude/settings.json`) and `pnpm bootstrap`
says when it is not installed.

- **During review** of a change in the scope above: run its _scan changes_
  job on the branch. A confirmed finding is a blocker, like a threat-model
  `fail`.
- **Before `/ship`**: run its _scan codebase_ job. Its report goes beside the
  threat-model review in the ship decision.
- **Not installed** (or the harness lacks what it needs): say _could not run_
  in the report. It is never silently a pass.

Whichever ran, the rule from the threat-model review stands: **never approve
your own fixes**. A fix made in this session is re-checked by a fresh review
or scan.
