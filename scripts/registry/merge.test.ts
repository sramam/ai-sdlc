import { describe, expect, it } from "vitest";
import {
  addBuiltDependencies,
  differences,
  mergeConfig,
  mergeLines,
  mergePackage,
  unionJson,
} from "./merge.mjs";

describe("unionJson", () => {
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
  });

  it("matches CI steps and databases by name", () => {
    const config = { ci: { steps: [{ name: "lint", run: "mine" }] } };
    const item = {
      ci: {
        steps: [
          { name: "lint", run: "theirs" },
          { name: "cov", run: "c" },
        ],
      },
    };
    expect(unionJson(config, item)).toEqual({
      ci: {
        steps: [
          { name: "lint", run: "mine" },
          { name: "cov", run: "c" },
        ],
      },
    });
  });
});

describe("mergeConfig", () => {
  it("adds what is missing and names what the project kept", () => {
    const { config, kept } = mergeConfig(
      { ci: { steps: [{ name: "lint", run: "mine" }] }, coverage: { floors: {} } },
      {
        ci: {
          steps: [
            { name: "lint", run: "theirs" },
            { name: "cov", run: "c" },
          ],
        },
      },
    );
    expect(config).toEqual({
      ci: {
        steps: [
          { name: "lint", run: "mine" },
          { name: "cov", run: "c" },
        ],
      },
      coverage: { floors: {} },
    });
    expect(kept).toEqual(["ci.steps[lint].run"]);
  });
  it("reports nothing when the fragment is already contained", () => {
    expect(differences({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [2], b: { c: 1 } })).toEqual([]);
  });
});

describe("mergePackage", () => {
  it("adds missing keys, keeps the project's differing values and reports them", () => {
    const { pkg, added, kept } = mergePackage(
      { name: "p", scripts: { test: "jest" } },
      { scripts: { test: "vitest run", lint: "eslint ." }, devDependencies: { vitest: "4.1.11" } },
    );
    expect(pkg).toEqual({
      name: "p",
      scripts: { test: "jest", lint: "eslint ." },
      devDependencies: { vitest: "4.1.11" },
    });
    expect(added).toEqual(["scripts.lint", "devDependencies.vitest"]);
    expect(kept).toEqual(['scripts.test: kept "jest", the item has "vitest run"']);
  });
  it("is idempotent", () => {
    const frag = { scripts: { a: "x" } };
    const once = mergePackage({}, frag).pkg;
    expect(mergePackage(once, frag)).toEqual({ pkg: once, added: [], kept: [] });
  });
});

describe("addBuiltDependencies", () => {
  it("turns an inline empty list into a block list", () => {
    expect(
      addBuiltDependencies("packages: []\nonlyBuiltDependencies: []\nx: 1\n", ["b", "a"]),
    ).toBe("packages: []\nonlyBuiltDependencies:\n  - b\n  - a\nx: 1\n");
  });
  it("extends a block list without duplicates, and is idempotent", () => {
    const once = addBuiltDependencies("onlyBuiltDependencies:\n  - esbuild\n# end\n", [
      "esbuild",
      "sharp",
    ]);
    expect(once).toBe("onlyBuiltDependencies:\n  - esbuild\n  - sharp\n# end\n");
    expect(addBuiltDependencies(once, ["sharp"])).toBe(once);
  });
  it("adds the key when the file has none", () => {
    expect(addBuiltDependencies("packages: []\n", ["x"])).toBe(
      "packages: []\n\nonlyBuiltDependencies:\n  - x\n",
    );
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
