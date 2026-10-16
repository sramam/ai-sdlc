# Release

The skill does the remembering. A person decides whether the work is worth naming.

**Checklist:**

1. **Report.** Run `pnpm release` and read what it prints: the latest version, how many commits are unreleased, and the `local-ci` verdict on the commit. If nothing is unreleased, there is nothing to name.
2. **Plan.** Run `pnpm release --minor` (or `--patch`, or `--major`, which is a person's call). Add `--at <sha>` for an earlier commit on `origin/dev`. The plan prints the tag, the range and the notes, and writes nothing.
3. **Read the notes.** They are the `Progress:` / `Closes:` / `No-Item:` trailers since the previous version, grouped by item. Check the count of commits with no trailer: if it is large, the notes say little.
4. **A person agrees.** Show them the plan and wait for a yes. Never take one from another agent.
5. **Cut it.** Run `pnpm release --minor --yes`. This creates an annotated tag locally. It does not push, and it bumps no `package.json`. Pushing (`git push origin refs/tags/<tag>`) makes the name public, so ask before doing it.

**What it refuses:**

- a dirty tree
- a commit not on `origin/dev`
- a tag that already exists
- a version that is not an increase
- a `local-ci` status that is missing or not success

On the `local-ci` status: red has no override. `--allow-unknown` covers only an unknown status, and it writes into the tag annotation that nobody checked.

**A version says which code, never which journeys are testable.** Releasing a journey to QA is `/journeys ready-for-qa` and a person's judgement. A tag does not move a branch either: promotion is `pnpm promote:staging` / `pnpm promote:prod`.
