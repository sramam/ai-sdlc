/**
 * A census of the permission rules that keep merges and hook bypasses out of
 * an agent's hands on this machine. Merging happens only through `pnpm land`;
 * GitHub enforces it server-side only on a public repo or a paid plan, so on a
 * private free repo these rules (with pre-push) are the whole local guard. A
 * rule removed from `.claude/settings.json` fails here rather than quietly.
 *
 * Permission rules match the command text, so they are a guardrail against an
 * agent's ordinary command, not a boundary: `gh api …/merge` or a script that
 * merges is not matched. That is what server-side rules are for.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SETTINGS = join(import.meta.dirname, "..", "..", "..", ".claude", "settings.json");

const REQUIRED_DENY = [
  "Bash(gh pr merge:*)",
  "Bash(git push origin dev:*)",
  "Bash(git push origin HEAD:dev:*)",
  "Bash(git push --no-verify:*)",
  "Bash(git push * --no-verify:*)",
  "Bash(git commit --no-verify:*)",
  "Bash(git commit * --no-verify:*)",
  "Bash(git commit -n:*)",
  "Bash(git push --force:*)",
  "Bash(git push * --force:*)",
  "Bash(git push -f:*)",
  "Bash(git push * -f:*)",
];

type Settings = { permissions?: { allow?: string[]; ask?: string[]; deny?: string[] } };
const settings = JSON.parse(readFileSync(SETTINGS, "utf8")) as Settings;

describe(".claude/settings.json permissions", () => {
  it.each(REQUIRED_DENY)("denies %s", (rule) => {
    expect(settings.permissions?.deny ?? []).toContain(rule);
  });

  it("allows and asks for none of them — a deny is not to be shadowed by intent", () => {
    const loose = [...(settings.permissions?.allow ?? []), ...(settings.permissions?.ask ?? [])];
    for (const rule of REQUIRED_DENY) expect(loose).not.toContain(rule);
  });
});
