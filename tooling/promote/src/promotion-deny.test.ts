/**
 * The permission rules that keep an agent from moving staging or main with a
 * raw `git push` — the road around `pnpm promote`'s approval, migration,
 * deploy and smoke test. `.husky/pre-push` refuses the same pushes (see
 * promote.git.test.ts); these stop the command before it runs at all.
 *
 * A permission rule matches command text, so this is a guardrail against an
 * ordinary command, not a boundary. `matches` below approximates Claude Code's
 * rule syntax (`:*` as a prefix, `*` as a wildcard) closely enough to check
 * that the forms of the push somebody would actually type are covered; the
 * harness's own matcher is the authority.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SETTINGS = join(import.meta.dirname, "..", "..", "..", ".claude", "settings.json");

const PROMOTION_DENY = [
  "Bash(git push origin staging:*)",
  "Bash(git push origin main:*)",
  "Bash(git push origin HEAD:staging:*)",
  "Bash(git push origin HEAD:main:*)",
  "Bash(git push * *:staging:*)",
  "Bash(git push * *:main:*)",
  "Bash(git push * *:refs/heads/staging:*)",
  "Bash(git push * *:refs/heads/main:*)",
  "Bash(git push * *:refs/heads/dev:*)",
];

type Settings = { permissions?: { allow?: string[]; ask?: string[]; deny?: string[] } };
const settings = JSON.parse(readFileSync(SETTINGS, "utf8")) as Settings;
const deny = settings.permissions?.deny ?? [];

function matches(rule: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m?.[1]) return false;
  const prefix = m[1].endsWith(":*");
  const body = prefix ? m[1].slice(0, -2) : m[1];
  const re = body
    .split("*")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}${prefix ? "" : "$"}`).test(command);
}
const denied = (command: string) => deny.some((r) => matches(r, command));

describe(".claude/settings.json denies raw pushes to staging and main", () => {
  it.each(PROMOTION_DENY)("denies %s", (rule) => {
    expect(deny).toContain(rule);
  });

  it("allows and asks for none of them", () => {
    const loose = [...(settings.permissions?.allow ?? []), ...(settings.permissions?.ask ?? [])];
    for (const rule of PROMOTION_DENY) expect(loose).not.toContain(rule);
  });

  const sha = "0123456789abcdef0123456789abcdef01234567";
  it.each([
    `git push origin ${sha}:refs/heads/staging`,
    `git push origin ${sha}:refs/heads/main`,
    `git push -u origin ${sha}:refs/heads/main`,
    "git push origin dev:staging",
    "git push origin staging:main",
    "git push origin HEAD:staging",
    "git push origin HEAD:main",
    "git push origin staging",
    "git push origin main",
    "git push origin feat/x:refs/heads/dev",
  ])("covers `%s`", (command) => {
    expect(denied(command)).toBe(true);
  });

  it.each(["git push -u origin HEAD", "git push origin feat/staging-copy"])(
    "leaves an ordinary branch push alone: `%s`",
    (command) => {
      expect(denied(command)).toBe(false);
    },
  );
});
