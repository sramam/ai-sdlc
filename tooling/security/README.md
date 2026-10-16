# @ai-sdlc/security

**`security:scan [--only <check>[,<check>]] [--staged]`**: the supply-chain and secret checks from docs/kit/security.md, one line per check: `pass`, `fail` or `could-not-run`, findings indented beneath. Exit 0 all passed, 1 any failed, 2 none failed but one could not run (a held verdict, never a pass). `--staged` scans the staged diff and implies `--only secrets`.

| check             | asks                                                                                                                                                         | could not run when                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `secrets`         | built-in patterns over every tracked file (or the staged diff), plus gitleaks (`git` mode) and TruffleHog (`filesystem`, `--no-verification`) when installed | git cannot list files                                 |
| `deps`            | `pnpm audit --json` over the whole lockfile (root tooling included), failing at `deps.failAt`                                                                | pnpm missing, timeout, registry error, no JSON report |
| `licenses`        | every package under `node_modules/.pnpm` against the license allow-list, SPDX expressions evaluated                                                          | no `node_modules/.pnpm`                               |
| `install-scripts` | every package with a `preinstall`/`install`/`postinstall` (or a bare `binding.gyp`) against `onlyBuiltDependencies`                                          | no install; `onlyBuiltDependenciesFile`               |
| `release-age`     | `minimumReleaseAge` (minutes, pnpm ≥ 10.16.0) declared in `pnpm-workspace.yaml` or `minimum-release-age` in `.npmrc`, and read back by `pnpm config get`     | pnpm missing or its version unreadable                |

**Secret rules** (`src/secrets.mts` `RULES`): private key blocks; AWS access key ids and `aws_secret_access_key`; GCP API keys and service-account `private_key_id`; Cloudflare `CLOUDFLARE_API_TOKEN`/`CF_API_KEY` assignments and origin CA keys; GitHub `gh[pousr]_` and `github_pat_`; Anthropic `sk-ant-`; OpenAI `sk-proj-`/`sk-svcacct-`/`sk-admin-` and the legacy `T3BlbkFJ` shape; Stripe `sk_`/`rk_` live and test keys and `whsec_`; Slack `xox?-` tokens and webhooks; and `*_SECRET` / `*_API_KEY` / `*_ACCESS_KEY` / `*_TOKEN` / `*_PASSWORD` / `*_PRIVATE_KEY` assignments whose value is ≥ 20 characters, has letters and digits, is not a placeholder, and has ≥ 3.5 bits/char of entropy. A committed `.env*` or `.dev.vars*` (other than `.example`/`.sample`/`.template`) is a finding by itself. Reports name file, line and rule, never the value.

**Policy that only shrinks.** A secrets allow-list entry, a deps ignore, a license exception or an `onlyBuiltDependencies` entry that no longer excuses anything fails the check (secrets: on a full scan only).

## `security.config.json` (optional, repository root)

Absent means the defaults. Every exception needs a `reason` of at least three words; unknown keys are refused.

```json
{
  "secrets": {
    "allow": [
      {
        "path": "fixtures/**",
        "pattern": "github-token",
        "rule": "github-token",
        "reason": "a revoked published sample"
      }
    ],
    "exclude": ["vendor/**"]
  },
  "deps": {
    "failAt": "high",
    "ignore": [{ "id": "GHSA-xxxx-xxxx-xxxx", "reason": "dev only, not reachable" }]
  },
  "licenses": {
    "allow": [
      "MIT",
      "ISC",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "Apache-2.0",
      "0BSD",
      "BlueOak-1.0.0",
      "CC0-1.0",
      "Unlicense",
      "MIT-0",
      "Python-2.0"
    ],
    "warn": ["MPL-2.0"],
    "exceptions": [{ "package": "name or name@version", "reason": "why it is acceptable" }]
  },
  "releaseAge": { "minMinutes": 1440 }
}
```

`pattern` is a regex tested against the offending line and against the rule id; `path` is a glob (`**` crosses directories). `licenses.allow`/`warn` replace the defaults when given.

The threat-model review (`.agents/skills/security-and-hardening/threat-model-review.md`) runs this in the background and then reviews the diff by hand. The project's own: it arrives with `pnpm sdlc add security`; `pnpm sdlc diff security` shows what changed upstream, and `pnpm sdlc update security` takes it without overwriting a local edit (docs/kit/registry.md).
