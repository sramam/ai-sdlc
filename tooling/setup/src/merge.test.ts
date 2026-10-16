import { describe, expect, it } from "vitest";
import { mergeJsonText, mergeLines, ownedKeysJson, unionJson } from "./merge.mts";

describe("merge-json (union)", () => {
  const project = {
    model: "mine",
    permissions: { allow: ["A", "Mine"], deny: ["D"] },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "mine", timeout: 5 }] },
        { matcher: "Edit", hooks: [{ type: "command", command: "x" }] },
      ],
    },
  };
  const starter = {
    model: "theirs",
    worktree: { baseRef: "head" },
    permissions: { allow: ["A", "B"], deny: ["D", "E"], ask: ["Q"] },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "guard", timeout: 15 }] },
        { matcher: "Edit", hooks: [{ type: "command", command: "x", timeout: 15 }] },
      ],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "trace" }] }],
    },
  };

  it("unions lists by value, merges hooks by matcher and command, and never removes a project's addition", () => {
    const out = unionJson(project, starter) as typeof starter & typeof project;
    expect(out.model).toBe("mine");
    expect(out.worktree).toEqual({ baseRef: "head" });
    expect(out.permissions).toEqual({ allow: ["A", "Mine", "B"], deny: ["D", "E"], ask: ["Q"] });
    expect(out.hooks.PreToolUse).toEqual([
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "mine", timeout: 5 },
          { type: "command", command: "guard", timeout: 15 },
        ],
      },
      // Same hook by command: the project's timeout stands, the missing key is added.
      { matcher: "Edit", hooks: [{ type: "command", command: "x", timeout: 15 }] },
    ]);
    expect(out.hooks.PostToolUse).toHaveLength(1);
  });

  it("keeps what the starter dropped", () => {
    expect(unionJson({ allow: ["old", "new"] }, { allow: ["new"] })).toEqual({
      allow: ["old", "new"],
    });
  });

  it("is idempotent", () => {
    const once = unionJson(project, starter);
    expect(unionJson(once, starter)).toEqual(once);
    const text = mergeJsonText(JSON.stringify(project), JSON.stringify(starter));
    expect(mergeJsonText(text, JSON.stringify(starter))).toBe(text);
  });

  it("leaves an already-merged file's formatting alone", () => {
    const text = '{"a": [1,2],   "b": 1}';
    expect(mergeJsonText(text, '{"a":[2]}')).toBe(text);
  });

  it("creates the file from the starter's when the project has none", () => {
    expect(JSON.parse(mergeJsonText(null, '{"a":1}'))).toEqual({ a: 1 });
  });

  it("refuses a project file that is not JSON rather than overwriting it", () => {
    expect(() => mergeJsonText("{ x", "{}")).toThrow(/not valid JSON/);
  });
});

describe("merge-json (owned keys)", () => {
  const keys = { scripts: ["ci:local", "gone"], devDependencies: ["vitest"] };
  it("sets only the starter's keys, to the starter's values", () => {
    const out = ownedKeysJson(
      {
        name: "p",
        scripts: { "ci:local": "old", test: "jest", gone: "keep" },
        devDependencies: {},
      },
      {
        name: "s",
        scripts: { "ci:local": "new", test: "vitest" },
        devDependencies: { vitest: "4", eslint: "9" },
      },
      keys,
    );
    expect(out).toEqual({
      name: "p",
      scripts: { "ci:local": "new", test: "jest", gone: "keep" },
      devDependencies: { vitest: "4" },
    });
  });
  it("is idempotent", () => {
    const s = JSON.stringify({ scripts: { "ci:local": "new" }, devDependencies: { vitest: "4" } });
    const once = mergeJsonText('{"scripts":{"x":"y"}}', s, keys);
    expect(mergeJsonText(once, s, keys)).toBe(once);
  });
});

describe("merge-lines", () => {
  it("adds missing lines after their neighbour in the starter's file, and removes none", () => {
    const project = 'packages:\n  - "apps/*"\n\nonlyBuiltDependencies: []\n# ours\n';
    const starter =
      'packages:\n  - "tooling/*"\n  - "apps/*"\n  - "packages/*"\n\nonlyBuiltDependencies: []\n';
    expect(mergeLines(project, starter)).toBe(
      'packages:\n  - "tooling/*"\n  - "apps/*"\n  - "packages/*"\n\nonlyBuiltDependencies: []\n# ours\n',
    );
  });

  it("appends a line with no neighbour, and never adds blanks", () => {
    expect(mergeLines("a\n", "\n\nz\n")).toBe("a\nz\n");
  });

  it("is idempotent, and returns the project's text untouched when nothing is missing", () => {
    const starter = ".env\n.dev.vars\nnode_modules/\n";
    const once = mergeLines("node_modules/\n/build", starter);
    expect(mergeLines(once, starter)).toBe(once);
    expect(mergeLines("x\r\n.env  \n", ".env\n")).toBe("x\r\n.env  \n");
  });

  it("creates the file when the project has none", () => {
    expect(mergeLines(null, "a\n\nb\n")).toBe("a\nb\n");
  });
});
