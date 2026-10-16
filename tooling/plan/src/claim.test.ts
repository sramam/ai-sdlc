import { describe, expect, it } from "vitest";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult, ScriptedCall } from "../../core/src/exec.mts";
import { claim, claimBranch, claimMessage, main } from "./claim.mts";
import type { ClaimDeps } from "./claim.mts";
import { parseItem } from "./plan-lib.mts";

const TIP = "a".repeat(40);
const TREE = "b".repeat(40);
const SHA = "c".repeat(40);
const NOW = new Date("2026-10-15T09:30:00.000Z");

const items = [
  parseItem(
    "---\nid: F03-012\ntitle: Stop reminders\n---\n",
    "docs/plan/items/F03-012-x.md",
    "F03-012-x.md",
  ),
  parseItem(
    "---\nid: F03-013\ntitle: Gone\ndropped: 2026-10-01 not needed\n---\n",
    "docs/plan/items/F03-013-x.md",
    "F03-013-x.md",
  ),
];

type Rule = [RegExp | string, ExecResult | ((call: ScriptedCall) => ExecResult)];

function deps(
  rules: Rule[],
): ClaimDeps & { lines: string[]; exec: ReturnType<typeof scriptedExec> } {
  const lines: string[] = [];
  return {
    root: "/repo",
    integration: "dev",
    items,
    exec: scriptedExec(rules),
    now: () => NOW,
    log: (l) => lines.push(l),
    lines,
  };
}

const happy: Rule[] = [
  [/^git config user\.email$/, result(0, "me@example.com\n")],
  [/^gh api repos\/\{owner\}\/\{repo\}\/git\/ref\/heads\/dev /, result(0, `${TIP}\n`)],
  [new RegExp(`^gh api repos/\\{owner\\}/\\{repo\\}/git/commits/${TIP} `), result(0, `${TREE}\n`)],
  [/^gh api repos\/\{owner\}\/\{repo\}\/git\/commits -f/, result(0, `${SHA}\n`)],
  [/^gh api repos\/\{owner\}\/\{repo\}\/git\/refs /, result(0, "{}")],
];

describe("the claim commit", () => {
  it("has the documented message and a canonical branch", () => {
    expect(claimMessage("F03-012", "session-1", NOW)).toBe(
      "Claim: F03-012\n\nClaimed-By: session-1\nClaimed-At: 2026-10-15T09:30:00.000Z",
    );
    expect(claimBranch("F03-012")).toBe("f03-012");
  });
});

describe("claim", () => {
  it("creates a commit on the integration tip, then the ref, and prints the next commands", async () => {
    const d = deps(happy);
    expect(await claim("f03-012", { session: "session-1" }, d)).toBe(0);
    const calls = d.exec.calls.map((c) => [c.cmd, ...c.args]);
    expect(calls).toEqual([
      ["gh", "api", "repos/{owner}/{repo}/git/ref/heads/dev", "--jq", ".object.sha"],
      ["gh", "api", `repos/{owner}/{repo}/git/commits/${TIP}`, "--jq", ".tree.sha"],
      [
        "gh",
        "api",
        "repos/{owner}/{repo}/git/commits",
        "-f",
        `message=Claim: F03-012\n\nClaimed-By: session-1\nClaimed-At: ${NOW.toISOString()}`,
        "-f",
        `tree=${TREE}`,
        "-f",
        `parents[]=${TIP}`,
        "--jq",
        ".sha",
      ],
      [
        "gh",
        "api",
        "repos/{owner}/{repo}/git/refs",
        "-f",
        "ref=refs/heads/f03-012",
        "-f",
        `sha=${SHA}`,
      ],
    ]);
    const out = d.lines.join("\n");
    expect(out).toContain("F03-012 claimed as origin/f03-012 by session-1");
    expect(out).toContain("git fetch origin f03-012");
    expect(out).toContain(".claude/worktrees/f03-012 -b f03-012 origin/f03-012");
  });

  it("claims as git config user.email without --session", async () => {
    const d = deps(happy);
    expect(await claim("F03-012", {}, d)).toBe(0);
    expect(d.lines.join()).toContain("by me@example.com");
  });

  it("a second claim of the same item is the same ref: exit 3, naming who holds it", async () => {
    const holderReply = JSON.stringify([
      { sha: "d".repeat(40), commit: { message: "wip" } },
      {
        sha: "e".repeat(40),
        commit: {
          message: "Claim: F03-012\n\nClaimed-By: session-other\nClaimed-At: 2026-10-14T08:00:00Z",
        },
      },
    ]);
    const d = deps([
      [
        /git\/refs /,
        result(
          1,
          '{"message":"Reference already exists"}',
          "gh: Reference already exists (HTTP 422)",
        ),
      ],
      [/commits\?sha=f03-012&per_page=100$/, result(0, holderReply)],
      ...happy,
    ]);
    expect(await claim("F03-012", { session: "session-1" }, d)).toBe(3);
    expect(d.lines.join()).toContain(
      "F03-012 is already claimed: session-other, since 2026-10-14T08:00:00Z",
    );
  });

  it("a held branch with no Claim: commit is reported as made outside pnpm claim", async () => {
    const d = deps([
      [/git\/refs /, result(1, "", "gh: Reference already exists (HTTP 422)")],
      [
        /commits\?sha=/,
        result(0, JSON.stringify([{ sha: "f".repeat(40), commit: { message: "x" } }])),
      ],
      ...happy,
    ]);
    expect(await claim("F03-012", { session: "s" }, d)).toBe(3);
    expect(d.lines.join()).toContain("made outside pnpm claim");
  });

  it("could not ask: gh missing, or the API refusing for another reason", async () => {
    const missing = deps([[/^gh /, result(127, "", "spawn gh ENOENT")]]);
    expect(await claim("F03-012", { session: "s" }, missing)).toBe(1);
    expect(missing.lines.join()).toContain("gh is not installed");
    const denied = deps([
      [/git\/refs /, result(1, "", "gh: Resource not accessible by integration (HTTP 403)")],
      ...happy,
    ]);
    expect(await claim("F03-012", { session: "s" }, denied)).toBe(1);
    expect(denied.lines.join()).toContain("HTTP 403");
  });

  it("refuses a bad ID, an unknown or dropped item, and an anonymous claimant", async () => {
    expect(await claim("F3", { session: "s" }, deps(happy))).toBe(2);
    expect(await claim("F09-001", { session: "s" }, deps(happy))).toBe(2);
    expect(await claim("F03-013", { session: "s" }, deps(happy))).toBe(2);
    const anon = deps([[/^git config/, result(1, "")], ...happy]);
    expect(await claim("F03-012", {}, anon)).toBe(2);
    expect(anon.exec.calls.some((c) => c.cmd === "gh")).toBe(false);
  });

  it("main refuses usage errors before touching the network", async () => {
    const exec = scriptedExec([]);
    expect(await main([], exec)).toBe(2);
    expect(await main(["F03-012", "--session"], exec)).toBe(2);
    expect(exec.calls).toEqual([]);
  });
});
