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
  checkAttribution,
  checkItemTrailers,
  checkRangeHasItem,
  checkRequirementsTrailer,
  indexedItemIds,
  messageMode,
  rangeMode,
  readAttribution,
  upstreamWarnings,
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
  it("upstream: warns, never refuses", () => {
    expect(
      upstreamWarnings(["tooling/guards/src/x.mts", ".claude/skills/land/SKILL.md", "src/a.ts"])[0]
        ?.state,
    ).toBe("warn");
    expect(upstreamWarnings([".claude/skills/mine/SKILL.md"])[0]?.state).toBe("ok");
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
