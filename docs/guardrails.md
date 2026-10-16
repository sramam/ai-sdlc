# Guardrails

The project's non-negotiables, short enough to import into every session. The
first block arrives with `ai-sdlc init`; the second is the project's own, added by
`/kickoff` (working agreements) or by an ADR. A rule here is enforced by
something wherever possible, and says by what.

## From the kit

- **Default to the most private option; relax on evidence, never in
  anticipation.** A relaxation is an ADR with a reason and a date.
- **`docs/requirements/` is written only by `/kickoff` and `/spec`**;
  `sources/` is never edited: a new file arrives through Write by a
  requirements skill and `pnpm sources:add`. _Hook + commit trailer; the
  sources manifest check._
- **The design brief beats a mockup or a prototype.** Record a divergence in the
  brief; never follow the picture silently.
- **No new technology or dependency without an ADR** the user decided
  (docs/kit/technology-decisions.md). _`plan:check --stage build`._
- **Ask before building anything outside the MVP scope** in the project brief.
- **Secrets never reach the repo, logs, telemetry or an agent's context.**
  _Deny list in `.claude/settings.json` (a courtesy, not a boundary:
  docs/kit/security.md § Our own agents and machines); secret scan in
  `ci:local`._
- **Permissions go in `.claude/settings.json`.** A grant that runs an arbitrary
  interpreter (`python3 -c`, `node -e`, `sh -c`) is a personal trust decision and
  belongs in `settings.local.json`.
- **All database access goes through `@<scope>/db`.** If raw SQL seems needed,
  stop and ask.
- **No GitHub Actions workflows** unless the author opts in. CI is `ci:local`.
- **Never push an integration branch directly, never squash.** _`pre-push`;
  repo settings._
- **Architecture decisions are ADRs; process decisions are a line in
  `AGENTS.md`.** Static docs carry no numbers about _now_; name the command
  that answers them.
- **Docs are succinct and complete.**

## This project's own

<!-- Added by /kickoff (topic 8, working agreements) or by an ADR. One line each,
     with what enforces it. -->
