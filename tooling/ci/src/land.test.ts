import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SdlcConfig } from "../../core/src/config.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult, ScriptedCall } from "../../core/src/exec.mts";
import type { CiOptions } from "./ci-local.mts";
import { isDiscoveryBranch, parseLandArgs, parseRangeTrailers, prBody, runLand } from "./land.mts";
import type { CiResult, LandDeps } from "./land.mts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MOVED = "e".repeat(40);
const MERGE = "f".repeat(40);

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "land-test-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const config: SdlcConfig = {
  branches: { integration: "dev", staging: "staging", production: "main" },
  dirs: {
    requirements: "docs/requirements",
    plan: "docs/plan",
    progress: "docs/progress",
    adr: "docs/adr",
    handoffs: "docs/handoffs",
  },
  claimStaleDays: 7,
  cadence: { progressReportWeekdays: [1, 4], planSyncDays: 7 },
  accounts: [],
  ci: { steps: [] },
  coverage: { floors: {} },
};

type Rule = [RegExp | string, ExecResult | ((c: ScriptedCall) => ExecResult)];

const LOG_OUT =
  "f1-002: add the thing\x1fProgress: F1-002 form done; validation remains\n\x1e" +
  "f1-002: finish\x1fCloses: F1-002\n\x1e";

/** A branch ready to land: every precondition holds and every remote call succeeds. */
function happy(over: Rule[] = [], opts: { branch?: string; log?: string } = {}): Rule[] {
  let fetches = 0;
  return [
    ...over,
    ["git symbolic-ref --quiet --short HEAD", result(0, `${opts.branch ?? "f1-002-thing"}\n`)],
    ["git status --porcelain", result(0, "")],
    [/^git fetch/, () => (fetches++, result(0))],
    [
      /^git rev-parse --verify --quiet origin\/dev\^\{commit\}$/,
      // after the merge (third fetch), origin/dev is the merge commit
      () => result(0, `${fetches >= 3 ? MERGE : BASE}\n`),
    ],
    [/^git rev-parse --verify HEAD\^\{commit\}$/, result(0, `${HEAD}\n`)],
    [/^git merge-base --is-ancestor/, result(0)],
    [/^node tooling\/guards\/src\/trailers\.mts --range origin\/dev$/, result(0, "ok")],
    [/^git log --reverse/, result(0, opts.log ?? LOG_OUT)],
    [/^git diff --name-only -z origin\/dev\.\.\.HEAD$/, result(0, "src/a.ts\0")],
    ["git push -u origin HEAD", result(0)],
    [
      /^gh pr view --json number/,
      result(1, "", 'no pull requests found for branch "f1-002-thing"'),
    ],
    [/^gh pr create/, result(0, "https://github.com/o/r/pull/42\n")],
    [
      /^gh pr view 42 --json headRefOid,state,baseRefName$/,
      result(0, JSON.stringify({ headRefOid: HEAD, state: "OPEN", baseRefName: "dev" })),
    ],
    [/^gh pr merge 42 --merge/, result(0)],
  ];
}

function landDeps(rules: Rule[], ci: (o: CiOptions) => CiResult = () => passCi) {
  const fake = scriptedExec(rules);
  const lines: string[] = [];
  const ciCalls: CiOptions[] = [];
  let body = "";
  const d: LandDeps = {
    exec: async (cmd, args, o) => {
      // Capture the generated body before land removes its temp directory.
      if (cmd === "gh" && args[1] === "create") {
        const f = args[args.indexOf("--body-file") + 1];
        if (f) body = readFileSync(f, "utf8");
      }
      return fake(cmd, args, o);
    },
    root: "/repo",
    loadConfig: async () => config,
    log: (l) => lines.push(l),
    runCi: async (o) => (ciCalls.push(o), ci(o)),
    tempDir: () => mkdtempSync(join(tmp, "body-")),
    // Never the real githubstatus.com from a test.
    githubStatus: async () => ({ state: "operational" }),
  };
  return { d, fake, ciCalls, lines, out: () => lines.join("\n"), body: () => body };
}

const passCi: CiResult = { exit: 0, verdict: "pass", status: "posted", context: "local-ci" };
const lineOf = (c: ScriptedCall) => [c.cmd, ...c.args].join(" ");
const merged = (fake: { calls: ScriptedCall[] }) =>
  fake.calls.some((c) => c.cmd === "gh" && c.args[1] === "merge");
const pushed = (fake: { calls: ScriptedCall[] }) =>
  fake.calls.some((c) => c.cmd === "git" && c.args[0] === "push");

describe("the happy path", () => {
  it("lands with a merge commit, deletes the branch on Closes:, and statuses the dev tip", async () => {
    const { d, fake, ciCalls, out, body } = landDeps(happy());
    const o = await runLand({ allowUnknown: false }, d);
    expect(o, out()).toMatchObject({ exit: 0, merged: true, pr: 42, mergeSha: MERGE });

    const order = fake.calls.map(lineOf);
    const at = (re: RegExp) => order.findIndex((l) => re.test(l));
    expect(at(/^git push/)).toBeLessThan(at(/^gh pr create/));
    expect(at(/^gh pr view 42/)).toBeLessThan(at(/^gh pr merge/));
    expect(order.find((l) => l.startsWith("gh pr merge"))).toBe(
      `gh pr merge 42 --merge --match-head-commit ${HEAD} --delete-branch`,
    );

    expect(ciCalls).toEqual([
      { sha: HEAD, allowUnknown: false, noStatus: false },
      { sha: "origin/dev", allowUnknown: false, noStatus: false },
    ]);
    expect(body()).toMatch(/Progress: F1-002 form done; validation remains/);
    expect(body()).toMatch(/Closes: F1-002/);
    expect(out()).toMatch(/merged into dev at ffffffffffff/);
  });

  it("never squashes, rebases, forces or uses admin", async () => {
    const { d, fake } = landDeps(happy());
    await runLand({ allowUnknown: false }, d);
    for (const l of fake.calls.map(lineOf))
      expect(l).not.toMatch(/--squash|--rebase|--force|--admin|-f\b/);
  });

  it("keeps the branch when nothing Closes:", async () => {
    const { d, fake } = landDeps(happy([], { log: "wip\x1fProgress: F1-002 half\n\x1e" }));
    expect((await runLand({ allowUnknown: false }, d)).exit).toBe(0);
    expect(fake.calls.map(lineOf).find((l) => l.startsWith("gh pr merge"))).toBe(
      `gh pr merge 42 --merge --match-head-commit ${HEAD}`,
    );
  });

  it("reuses an open PR into dev rather than creating one", async () => {
    const { d, fake } = landDeps(
      happy([
        [
          /^gh pr view --json number/,
          result(
            0,
            JSON.stringify({ number: 42, headRefOid: HEAD, state: "OPEN", baseRefName: "dev" }),
          ),
        ],
      ]),
    );
    expect((await runLand({ allowUnknown: false }, d)).exit).toBe(0);
    expect(fake.calls.some((c) => c.args[1] === "create")).toBe(false);
  });

  it("passes --allow-unknown to both ci:local runs and says the merge was an override", async () => {
    const { d, ciCalls, out } = landDeps(happy(), (o) =>
      o.sha === HEAD
        ? { exit: 0, verdict: "unknown", status: "posted", context: "local-ci/allow-unknown" }
        : passCi,
    );
    expect((await runLand({ allowUnknown: true }, d)).exit).toBe(0);
    expect(ciCalls.every((c) => c.allowUnknown)).toBe(true);
    expect(out()).toMatch(/ALLOWED UNKNOWN .*local-ci\/allow-unknown, not local-ci/);
  });

  it("treats a merge that succeeded but whose branch tidy-up failed as merged", async () => {
    const { d, out } = landDeps(
      happy([
        [/^gh pr merge/, result(1, "", "failed to delete local branch")],
        [/^gh pr view 42 --json state$/, result(0, JSON.stringify({ state: "MERGED" }))],
      ]),
    );
    expect((await runLand({ allowUnknown: false }, d)).exit).toBe(0);
    expect(out()).toMatch(/merged, but gh reported/);
  });
});

describe("refusals — each precondition stops before anything is pushed or merged", () => {
  const refuses = async (rules: Rule[], re: RegExp, ci?: (o: CiOptions) => CiResult) => {
    const { d, fake, out } = landDeps(rules, ci);
    const o = await runLand({ allowUnknown: false }, d);
    expect(o.exit, out()).not.toBe(0);
    expect(out()).toMatch(re);
    expect(merged(fake)).toBe(false);
    return { o, fake, out: out() };
  };

  it("on the integration branch", async () => {
    const { fake } = await refuses(
      happy([["git symbolic-ref --quiet --short HEAD", result(0, "dev\n")]]),
      /on dev/,
    );
    expect(pushed(fake)).toBe(false);
  });

  it("on production", async () => {
    await refuses(
      happy([["git symbolic-ref --quiet --short HEAD", result(0, "main\n")]]),
      /on main/,
    );
  });

  it("on a detached HEAD", async () => {
    await refuses(happy([["git symbolic-ref --quiet --short HEAD", result(1)]]), /detached/);
  });

  it("on a dirty tree", async () => {
    const { fake } = await refuses(
      happy([["git status --porcelain", result(0, " M src/a.ts\n")]]),
      /dirty/,
    );
    expect(pushed(fake)).toBe(false);
  });

  it("when the fetch cannot reach origin", async () => {
    const { o } = await refuses(
      happy([[/^git fetch/, result(128, "", "Could not resolve host")]]),
      /fetch/,
    );
    expect(o.exit).toBe(2);
  });

  it("when origin/dev is not an ancestor, naming the merge to do", async () => {
    const { fake } = await refuses(
      happy([[/^git merge-base --is-ancestor/, result(1)]]),
      /git merge origin\/dev. first/,
    );
    expect(pushed(fake)).toBe(false);
  });

  it("when no commit carries Progress: or No-Item:", async () => {
    const { fake } = await refuses(
      happy([[/^node tooling\/guards/, result(1, "REFUSED progress none of 2 commit(s)")]]),
      /needs a Progress:[\s\S]*|none of 2 commit/,
    );
    expect(pushed(fake)).toBe(false);
  });

  it("when requirements are mixed with other paths", async () => {
    await refuses(
      happy([[/^git diff --name-only/, result(0, "docs/requirements/brd.md\0src/a.ts\0")]]),
      /touches docs\/requirements\/ and 1 other path/,
    );
  });

  it("lets a requirements-only branch through", async () => {
    const { d } = landDeps(
      happy([[/^git diff --name-only/, result(0, "docs/requirements/brd.md\0")]]),
    );
    expect((await runLand({ allowUnknown: false }, d)).exit).toBe(0);
  });

  it("lets the x-000 discovery branch mix requirements with the rest", async () => {
    const { d } = landDeps(
      happy(
        [[/^git diff --name-only/, result(0, "docs/requirements/brd.md\0docs/adr/ADR-001.md\0")]],
        {
          branch: "x-000-discovery",
        },
      ),
    );
    expect((await runLand({ allowUnknown: false }, d)).exit).toBe(0);
  });

  it("when the push fails", async () => {
    const { out } = await refuses(
      happy([["git push -u origin HEAD", result(1, "", "rejected (non-fast-forward)")]]),
      /push/,
    );
    // A rejected push is about the repository, not the network: no diagnosis.
    expect(out).not.toMatch(/ github /);
  });

  it("after a network failure, says GitHub is fine and the problem is local, with the fix", async () => {
    const { o, out } = await refuses(
      happy([
        [
          "git push -u origin HEAD",
          result(
            1,
            "",
            "error: RPC failed; HTTP 408 curl 22 The requested URL returned error: 408",
          ),
        ],
      ]),
      /push/,
    );
    expect(out).toMatch(/github .*all systems operational.*upload stalled/);
    expect(o.stoppedAt).toBe("push");
  });

  it("after a network failure, points at GitHub when it reports a problem", async () => {
    const { d, out } = landDeps(
      happy([
        [
          /^git fetch/,
          result(128, "", "fatal: unable to access: Error in the HTTP2 framing layer"),
        ],
      ]),
    );
    d.githubStatus = async () => ({ state: "degraded", summary: "Git Operations: major outage" });
    const o = await runLand({ allowUnknown: false }, d);
    expect(o.exit).toBe(2);
    expect(o.stoppedAt).toBe("fetch");
    expect(out()).toMatch(/GitHub reports a problem \(Git Operations: major outage\)/);
  });

  it("when ci:local fails, after pushing and before any PR", async () => {
    const { fake } = await refuses(happy(), /ci:local fail/, () => ({
      exit: 1,
      verdict: "fail",
      status: "posted",
    }));
    expect(fake.calls.some((c) => c.cmd === "gh")).toBe(false);
  });

  it("when ci:local could not run and nothing was allowed", async () => {
    const { o } = await refuses(happy(), /ci:local unknown/, () => ({
      exit: 2,
      verdict: "unknown",
      status: "posted",
    }));
    expect(o.exit).toBe(2);
  });

  it("when an open PR targets another branch", async () => {
    await refuses(
      happy([
        [
          /^gh pr view --json number/,
          result(
            0,
            JSON.stringify({ number: 7, headRefOid: HEAD, state: "OPEN", baseRefName: "main" }),
          ),
        ],
      ]),
      /#7 targets main, not dev/,
    );
  });
});

describe("the re-check before merging", () => {
  it("stops when the PR head is not the tested SHA", async () => {
    const { d, fake, out } = landDeps(
      happy([
        [
          /^gh pr view 42 --json headRefOid,state,baseRefName$/,
          result(0, JSON.stringify({ headRefOid: MOVED, state: "OPEN", baseRefName: "dev" })),
        ],
      ]),
    );
    const o = await runLand({ allowUnknown: false }, d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "recheck", merged: false });
    expect(out()).toMatch(/not the tested aaaaaaaaaaaa — re-run land/);
    expect(merged(fake)).toBe(false);
  });

  it("stops when the PR was retargeted away from dev after it was found", async () => {
    const { d, fake, out } = landDeps(
      happy([
        [
          /^gh pr view 42 --json headRefOid,state,baseRefName$/,
          result(0, JSON.stringify({ headRefOid: HEAD, state: "OPEN", baseRefName: "main" })),
        ],
      ]),
    );
    const o = await runLand({ allowUnknown: false }, d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "recheck", merged: false });
    expect(out()).toMatch(/#42 now targets main, not dev/);
    expect(merged(fake)).toBe(false);
  });

  it("an unreadable base is not dev: refused, never merged", async () => {
    const { d, fake } = landDeps(
      happy([
        [
          /^gh pr view 42 --json headRefOid,state,baseRefName$/,
          result(0, JSON.stringify({ headRefOid: HEAD, state: "OPEN" })),
        ],
      ]),
    );
    expect(await runLand({ allowUnknown: false }, d)).toMatchObject({ stoppedAt: "recheck" });
    expect(merged(fake)).toBe(false);
  });

  it("pins the merge to the tested head, so a push after the re-check cannot ride in", async () => {
    const { d, fake } = landDeps(happy());
    await runLand({ allowUnknown: false }, d);
    const merge = fake.calls.find((c) => c.cmd === "gh" && c.args[1] === "merge");
    const i = merge?.args.indexOf("--match-head-commit") ?? -1;
    expect(i).toBeGreaterThan(-1);
    expect(merge?.args[i + 1]).toBe(HEAD);
  });

  it("stops when origin/dev moved since the run", async () => {
    let n = 0;
    const { d, fake, out } = landDeps(
      happy([
        // first read (step 4) is BASE, the re-check read sees it moved
        [
          /^git rev-parse --verify --quiet origin\/dev\^\{commit\}$/,
          () => result(0, `${n++ === 0 ? BASE : MOVED}\n`),
        ],
      ]),
    );
    const o = await runLand({ allowUnknown: false }, d);
    expect(o).toMatchObject({ exit: 1, stoppedAt: "recheck" });
    expect(out()).toMatch(/moved since the run/);
    expect(merged(fake)).toBe(false);
  });

  it("calls merge only after the re-check", async () => {
    const { d, fake } = landDeps(happy());
    await runLand({ allowUnknown: false }, d);
    const order = fake.calls.map(lineOf);
    const recheck = order.findIndex((l) => l.startsWith("gh pr view 42 --json headRefOid,state"));
    const secondFetch = order.findIndex((l, i) => i > recheck && l.startsWith("git fetch"));
    const merge = order.findIndex((l) => l.startsWith("gh pr merge"));
    expect(recheck).toBeGreaterThan(-1);
    expect(secondFetch).toBeGreaterThan(recheck);
    expect(merge).toBeGreaterThan(secondFetch);
  });
});

describe("after the merge", () => {
  it("reports a failed dev-tip status without claiming nothing merged", async () => {
    const { d, out } = landDeps(happy(), (o) =>
      o.sha === "origin/dev" ? { exit: 2, verdict: null, status: "skipped" } : passCi,
    );
    const o = await runLand({ allowUnknown: false }, d);
    expect(o).toMatchObject({ exit: 2, merged: true, stoppedAt: "dev-status" });
    expect(out()).toMatch(/the merge landed; re-run/);
    expect(out()).not.toMatch(/nothing merged/);
  });
});

describe("pure parts", () => {
  it("parseLandArgs", () => {
    expect(parseLandArgs([])).toEqual({ allowUnknown: false });
    expect(parseLandArgs(["--allow-unknown"])).toEqual({ allowUnknown: true });
    expect(parseLandArgs(["--squash"])).toHaveProperty("error");
  });

  it("parseRangeTrailers reads git's trailer block, not prose", () => {
    const t = parseRangeTrailers(LOG_OUT + "chore\x1fNo-Item: dependency bump\n\x1e");
    expect(t).toEqual({
      subjects: ["f1-002: add the thing", "f1-002: finish", "chore"],
      progress: ["F1-002 form done; validation remains"],
      closes: ["F1-002"],
      noItem: ["dependency bump"],
    });
  });

  it("prBody lists every trailer line", () => {
    const b = prBody(parseRangeTrailers(LOG_OUT), "dev");
    expect(b).toMatch(/^Progress: F1-002/m);
    expect(b).toMatch(/^Closes: F1-002$/m);
    expect(b).toMatch(/^- f1-002: finish$/m);
  });

  it("isDiscoveryBranch", () => {
    expect(isDiscoveryBranch("x-000-discovery")).toBe(true);
    expect(isDiscoveryBranch("X-000-discovery")).toBe(true);
    expect(isDiscoveryBranch("x-0001-other")).toBe(false);
    expect(isDiscoveryBranch("f1-002-x-000")).toBe(false);
  });
});
