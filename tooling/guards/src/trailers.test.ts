import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  commit,
  initRepo,
  sh,
  tempDir,
  write,
} from "../../plan/src/__fixtures__/plan/temp-repo.ts";
import {
  checkAggregateRequirements,
  checkAttribution,
  checkBranchItems,
  checkNoItem,
  isClaimCommit,
  itemOfBranch,
  checkItemTrailers,
  checkRangeHasItem,
  checkRangeTests,
  checkRequirementsTrailer,
  indexedItemIds,
  isSource,
  isTest,
  messageMode,
  rangeMode,
  readAttribution,
} from "./trailers.mts";
import { DEFAULT_DIRS } from "../../plan/src/plan-lib.mts";

const dirs: string[] = [];
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) cleanup(dirs.pop() ?? "");
});

const ATTR = "Co-Authored-By: Claude <noreply@anthropic.com>";
const T = (key: string, value: string) => ({ key, value });

describe("test evidence", () => {
  const commit = (...trailers: { key: string; value: string }[]) => ({
    commit: "a".repeat(40),
    time: 0,
    subject: "s",
    trailers,
  });

  it("tells source from tests, fixtures, declarations and config", () => {
    for (const p of ["apps/web/src/a.ts", "packages/api/x.tsx", "tooling/x/src/y.mts", "s.mjs"])
      expect(isSource(p), p).toBe(true);
    for (const p of [
      "apps/web/src/a.test.ts",
      "e2e/j1.spec.ts",
      "e2e/stack.mts",
      "x/__fixtures__/a.ts",
      "types.d.ts",
      "vitest.config.ts",
      "docs/a.md",
    ])
      expect(isSource(p), p).toBe(false);
    expect(isTest("e2e/stack.mts")).toBe(true);
  });

  it("passes when nothing runnable changed, or a test changed with it", () => {
    expect(checkRangeTests(["docs/a.md"], [commit()]).state).toBe("ok");
    expect(checkRangeTests(["src/a.ts", "src/a.test.ts"], [commit()]).state).toBe("ok");
  });

  it("refuses source with no test, naming the files", () => {
    const r = checkRangeTests(["src/a.ts", "src/b.ts"], [commit(T("Progress", "F01-001 x"))]);
    expect(r.state).toBe("refused");
    expect(r.text).toMatch(/src\/a\.ts, src\/b\.ts.*No-Test: <reason>/);
  });

  it("accepts a reason, and not an empty one", () => {
    expect(checkRangeTests(["src/a.ts"], [commit(T("No-Test", "a rename"))])).toMatchObject({
      state: "ok",
      text: expect.stringMatching(/because: a rename/),
    });
    expect(checkRangeTests(["src/a.ts"], [commit(T("No-Test", " "))]).state).toBe("refused");
  });
});

describe("pure checks", () => {
  it("requirements: refuses a docs/requirements change without the trailer", () => {
    const staged = ["docs/requirements/personas.md", "README.md"];
    expect(checkRequirementsTrailer(staged, [], "docs/requirements", false).state).toBe("refused");
    expect(
      checkRequirementsTrailer(staged, [T("Requirements", "notes")], "docs/requirements", false)
        .state,
    ).toBe("refused");
    expect(
      checkRequirementsTrailer(staged, [T("Requirements", "idea")], "docs/requirements", false)
        .state,
    ).toBe("ok");
    expect(checkRequirementsTrailer(["README.md"], [], "docs/requirements", false).state).toBe(
      "ok",
    );
    expect(checkRequirementsTrailer(staged, [], "docs/requirements", true).text).toContain("merge");
  });
  it("items: refuses Progress/Closes naming a missing item, case-insensitively", () => {
    const ids = new Set(["F01-001", "X-000"]);
    expect(
      checkItemTrailers([T("Progress", "f01-001 half done"), T("Closes", "X-000")], ids).state,
    ).toBe("ok");
    expect(checkItemTrailers([T("Progress", "F01-009 half")], ids).state).toBe("refused");
  });
  it("attribution: must equal the setting; absent setting or trailer allows", () => {
    const set = { state: "set" as const, line: ATTR };
    expect(
      checkAttribution([T("Co-Authored-By", "Claude <noreply@anthropic.com>")], set).state,
    ).toBe("ok");
    expect(
      checkAttribution([T("Co-authored-by", "Claude <noreply@anthropic.com>")], set).state,
    ).toBe("ok");
    expect(
      checkAttribution([T("Co-Authored-By", "Claude Opus 5 <noreply@anthropic.com>")], set).state,
    ).toBe("refused");
    expect(checkAttribution([], set).state).toBe("ok");
    // A person co-authors under their own address, and that is allowed.
    expect(
      checkAttribution(
        [
          T("Co-Authored-By", "Claude <noreply@anthropic.com>"),
          T("Co-Authored-By", "Ada <ada@example.com>"),
        ],
        set,
      ).state,
    ).toBe("ok");
    const absent = checkAttribution([T("Co-Authored-By", "anything")], {
      state: "absent",
      reason: "no setting",
    });
    expect(absent).toMatchObject({ state: "ok", text: expect.stringContaining("no setting") });
  });
  it("requirements: the folder README and .gitkeep files need no trailer", () => {
    expect(
      checkRequirementsTrailer(
        ["docs/requirements/README.md", "docs/requirements/sources/.gitkeep"],
        [],
        "docs/requirements",
        false,
      ).state,
    ).toBe("ok");
    expect(
      checkRequirementsTrailer(["docs/requirements/brd.md"], [], "docs/requirements", false).state,
    ).toBe("refused");
  });
  it("range: needs one Progress: or No-Item:", () => {
    const c = (trailers: Array<{ key: string; value: string }>) => ({
      commit: "x",
      time: 0,
      subject: "s",
      trailers,
    });
    expect(checkRangeHasItem([c([]), c([T("No-Item", "bump")])]).state).toBe("ok");
    expect(checkRangeHasItem([c([])]).state).toBe("refused");
  });
});

function repo(): string {
  const d = initRepo(tempDir());
  dirs.push(d);
  write(d, ".claude/settings.json", JSON.stringify({ attribution: { commit: ATTR } }));
  write(d, "docs/plan/items/X-000-discovery.md", "---\nid: X-000\ntitle: d\n---\n");
  commit(d, "init\n\nNo-Item: bootstrap");
  return d;
}

describe("--message against a real repository", () => {
  it("refuses a requirements change without Requirements:, allows it with one", async () => {
    const d = repo();
    write(d, "docs/requirements/personas.md", "## @a\n");
    sh(d, ["add", "-A"]);
    write(d, "msg", "docs: personas\n\nProgress: X-000 personas\n");
    expect(await messageMode(d, join(d, "msg"))).toBe(1);
    write(d, "msg", "docs: personas\n\nProgress: X-000 personas\nRequirements: idea\n");
    expect(await messageMode(d, join(d, "msg"))).toBe(0);
  });
  it("accepts an item staged in this very commit, refuses an unknown one", async () => {
    const d = repo();
    write(d, "docs/plan/items/F01-001-new.md", "---\nid: F01-001\ntitle: n\n---\n");
    sh(d, ["add", "-A"]);
    write(d, "msg", "plan: add F01-001\n\nProgress: F01-001 added\n");
    expect(await messageMode(d, join(d, "msg"))).toBe(0);
    write(d, "msg", "x\n\nCloses: F01-002\n");
    expect(await messageMode(d, join(d, "msg"))).toBe(1);
  });
  it("refuses a model-named attribution, ignores a quoted one in prose", async () => {
    const d = repo();
    write(
      d,
      "msg",
      "x\n\nProgress: X-000 y\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n",
    );
    expect(await messageMode(d, join(d, "msg"))).toBe(1);
    write(
      d,
      "msg",
      "x\n\nThe old trailer read Co-Authored-By: Claude Opus 5 <x> and was wrong.\n\nProgress: X-000 y\n" +
        ATTR +
        "\n",
    );
    expect(await messageMode(d, join(d, "msg"))).toBe(0);
  });
  it("indexes item IDs from file names and frontmatter", () => {
    const d = repo();
    const r = indexedItemIds(d, DEFAULT_DIRS);
    expect(r.ok && [...r.ids]).toEqual(["X-000"]);
    expect(readAttribution(d)).toEqual({ state: "set", line: ATTR });
  });
});

describe("--range against a real repository", () => {
  it("passes with a Progress:, refuses a range with none, and an unknown item", async () => {
    const d = repo();
    sh(d, ["branch", "base"]);
    commit(d, "feat: a\n\nProgress: X-000 half");
    expect(await rangeMode(d, "base", false)).toBe(0);
    commit(d, "feat: b\n\nProgress: F09-001 nope");
    expect(await rangeMode(d, "base", false)).toBe(1);
    const e = repo();
    sh(e, ["branch", "base"]);
    commit(e, "feat: no trailer");
    expect(await rangeMode(e, "base", false)).toBe(1);
  });
  it("defaults to the local integration branch without origin; nothing ahead passes", async () => {
    const d = repo();
    expect(await rangeMode(d, undefined, false)).toBe(0);
  });
  it("could not ask when there is no integration branch at all", async () => {
    const d = initRepo(tempDir(), "main");
    dirs.push(d);
    commit(d, "init");
    expect(await rangeMode(d, undefined, false)).toBe(1);
    expect(await rangeMode(d, undefined, true)).toBe(0);
  });
});

const C = (subject: string, trailers: Array<{ key: string; value: string }>, extra = {}) => ({
  commit: "abcdef1234",
  time: 0,
  subject,
  trailers,
  ...extra,
});

describe("assertions that must agree with one another", () => {
  it("No-Item: needs a reason of three words, and cannot sit beside Closes:", () => {
    expect(checkNoItem([T("No-Item", "bump")]).state).toBe("refused");
    expect(checkNoItem([T("No-Item", "dependency bump only")]).state).toBe("ok");
    expect(checkNoItem([T("No-Item", "a revert of abc"), T("Closes", "X-000")]).state).toBe(
      "refused",
    );
    expect(checkNoItem([T("Progress", "X-000 y")]).state).toBe("ok");
  });

  it("reads the item a branch is named after, longest ID first", () => {
    const ids = ["F01-001", "X-000", "F01-0011"];
    expect(itemOfBranch("f01-001", ids)).toBe("F01-001");
    expect(itemOfBranch("f01-001-login-form", ids)).toBe("F01-001");
    expect(itemOfBranch("x-000", ids)).toBe("X-000");
    expect(itemOfBranch("feat/f01-001", ids)).toBeNull();
    expect(itemOfBranch("f01-0012", ids)).toBeNull();
  });

  it("a branch closes only its own item; Progress: elsewhere warns", () => {
    const own = checkBranchItems("x-000-thing", "X-000", [C("a", [T("Closes", "x-000")])]);
    expect(own.map((l) => l.state)).toEqual(["ok"]);
    const other = checkBranchItems("x-000-thing", "X-000", [
      C("a", [T("Closes", "F01-001"), T("Progress", "F01-002 half")]),
    ]);
    expect(other.map((l) => l.state)).toEqual(["refused", "warn"]);
    expect(checkBranchItems("main", null, [])[0]?.state).toBe("ok");
    expect(checkBranchItems(null, null, [])[0]?.text).toMatch(/detached/);
  });

  it("an aggregate requirements change no commit owns is refused", () => {
    const owned = [{ ...C("a", []), paths: ["docs/requirements/brd.md"], merge: false }];
    expect(
      checkAggregateRequirements(["docs/requirements/brd.md"], owned, "docs/requirements").state,
    ).toBe("ok");
    expect(
      checkAggregateRequirements(["docs/requirements/prd.md"], owned, "docs/requirements").state,
    ).toBe("refused");
  });

  it("knows a Claim: commit by its subject", () => {
    expect(isClaimCommit({ subject: "Claim: F03-012" })).toBe(true);
    expect(isClaimCommit({ subject: "feat: Claim: nothing" })).toBe(false);
  });
});

describe("--range reads every commit, not the range as a whole", () => {
  it("refuses one requirements commit without a trailer even when another has one", async () => {
    const d = repo();
    sh(d, ["branch", "base"]);
    write(d, "docs/requirements/brd.md", "a\n");
    commit(d, "docs: brd\n\nProgress: X-000 brd\nRequirements: kickoff");
    expect(await rangeMode(d, "base", false)).toBe(0);
    write(d, "docs/requirements/brd.md", "b\n");
    commit(d, "fix: tweak\n\nProgress: X-000 tweak");
    expect(await rangeMode(d, "base", false)).toBe(1);
  });

  it("holds a merge to the paths it changed itself", async () => {
    const d = repo();
    sh(d, ["branch", "base"]);
    sh(d, ["checkout", "-q", "-b", "side"]);
    write(d, "docs/requirements/brd.md", "side\n");
    commit(d, "docs: brd\n\nProgress: X-000 brd\nRequirements: idea");
    sh(d, ["checkout", "-q", "dev"]);
    write(d, "src/a.ts", "1\n");
    commit(d, "feat: a\n\nProgress: X-000 a\nNo-Test: a fixture, not the subject here");
    sh(d, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
    // The merge takes brd.md from side unchanged: side's commit answers for it.
    expect(await rangeMode(d, "base", false)).toBe(0);

    // An edit made while merging is the merge's own, and needs its own trailer.
    sh(d, ["checkout", "-q", "-b", "side2", "base"]);
    write(d, "src/b.ts", "1\n");
    commit(d, "feat: b\n\nProgress: X-000 b\nNo-Test: a fixture, not the subject here");
    sh(d, ["checkout", "-q", "dev"]);
    sh(d, ["merge", "-q", "--no-ff", "--no-commit", "side2"]);
    write(d, "docs/requirements/prd.md", "evil\n");
    sh(d, ["add", "-A"]);
    sh(d, ["commit", "-q", "-m", "merge side2"]);
    expect(await rangeMode(d, "base", false)).toBe(1);
  });

  it("refuses a Closes: for another item on an item's branch", async () => {
    const d = repo();
    write(d, "docs/plan/items/F01-001-other.md", "---\nid: F01-001\ntitle: o\n---\n");
    commit(d, "plan: add\n\nNo-Item: adding the plan item");
    sh(d, ["branch", "base"]);
    sh(d, ["checkout", "-q", "-b", "x-000-discovery"]);
    commit(d, "feat: a\n\nProgress: X-000 a\nCloses: X-000");
    expect(await rangeMode(d, "base", false)).toBe(0);
    commit(d, "feat: b\n\nProgress: X-000 b\nCloses: F01-001");
    expect(await rangeMode(d, "base", false)).toBe(1);
  });

  it("refuses a thin No-Item:", async () => {
    const d = repo();
    sh(d, ["branch", "base"]);
    commit(d, "chore: bump\n\nNo-Item: bump");
    expect(await rangeMode(d, "base", false)).toBe(1);
  });

  it("exempts Claim: commits, which carry no trailers", async () => {
    const d = repo();
    sh(d, ["branch", "base"]);
    commit(d, "Claim: X-000");
    expect(await rangeMode(d, "base", false)).toBe(0);
    commit(d, "feat: a\n\nProgress: X-000 a");
    expect(await rangeMode(d, "base", false)).toBe(0);
  });
});

describe("--message during a merge", () => {
  it("lets a merged head's requirements through, and holds the merge's own edit", async () => {
    const d = repo();
    sh(d, ["checkout", "-q", "-b", "side"]);
    write(d, "docs/requirements/brd.md", "side\n");
    commit(d, "docs: brd\n\nProgress: X-000 brd\nRequirements: idea");
    sh(d, ["checkout", "-q", "dev"]);
    write(d, "src/a.ts", "1\n");
    commit(d, "feat: a\n\nProgress: X-000 a");
    sh(d, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
    write(d, "msg", "Merge side\n");
    expect(await messageMode(d, join(d, "msg"))).toBe(0);
    write(d, "docs/requirements/brd.md", "changed while merging\n");
    sh(d, ["add", "-A"]);
    expect(await messageMode(d, join(d, "msg"))).toBe(1);
    write(d, "msg", "Merge side\n\nRequirements: add-requirement\n");
    expect(await messageMode(d, join(d, "msg"))).toBe(0);
  });
});
