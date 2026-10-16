/**
 * The CLI, with no network and no install: a small registry built in a temp
 * directory is the source (`--from`), and projects are made beside it.
 * `pnpm registry:check` is the end-to-end run against this repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseArgs } from "./cli.mjs";
import { add, diff, init, list, update } from "./commands.mjs";
import { LOCK_FILE, readLock } from "./lock.mjs";
import { fetchSource, resolveSource } from "./source.mjs";

let dir: string;
let src: string;
let out: string[];
const ctx = (cwd: string) => ({
  cwd,
  log: (l: string) => out.push(l),
  version: "0.1.0",
  cliPath: join(import.meta.dirname, "cli.mjs"),
  cache: join(dir, "cache"),
});
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const REGISTRY = {
  registryVersion: 1,
  repo: "github:example/kit",
  exclude: {},
  registryOnly: { scripts: {} },
  items: {
    base: {
      kind: "base",
      description: "the base",
      files: [
        "tooling/core/",
        { from: "template/package.json", to: "package.json", seed: true },
        { from: "template/sdlc.config.json", to: "sdlc.config.json", seed: true },
        { from: ".gitignore", seed: true },
        { from: "pnpm-workspace.yaml", seed: true },
        "AGENTS.md",
      ],
      package: { scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.11" } },
    },
    alpha: {
      kind: "module",
      description: "a module",
      files: ["tooling/alpha/"],
      package: { scripts: { alpha: "node tooling/alpha/a.mts" } },
      config: { ci: { steps: [{ name: "alpha", run: "a", applies: "always" }] } },
      gitignore: [".alpha/"],
      notes: "Configure alpha.",
    },
    beta: {
      kind: "module",
      description: "needs alpha",
      requires: ["alpha"],
      files: ["tooling/beta/"],
      onlyBuiltDependencies: ["esbuild"],
    },
    gamma: {
      kind: "recipe",
      description: "conflicts with delta",
      conflicts: ["delta"],
      files: [{ from: "recipes/gamma/", to: "packages/x/" }],
    },
    delta: {
      kind: "recipe",
      description: "conflicts with gamma",
      conflicts: ["gamma"],
      files: [{ from: "recipes/delta/", to: "packages/x/" }],
    },
    frag: {
      kind: "recipe",
      description: "merges into an app",
      files: [{ from: "recipes/frag/f.ts", to: "apps/web/src/f.ts" }],
      packageJson: "apps/web/package.json",
      package: { dependencies: { zod: "4.1.0" } },
    },
  },
};

function makeSource(root: string) {
  put(root, "registry.json", json(REGISTRY));
  put(root, "template/package.json", json({ name: "", private: true, scripts: {} }));
  put(root, "template/sdlc.config.json", json({ ci: { steps: [] } }));
  put(root, ".gitignore", "node_modules/\n");
  put(root, "pnpm-workspace.yaml", 'packages:\n  - "tooling/*"\nonlyBuiltDependencies: []\n');
  put(root, "AGENTS.md", "# agents\n");
  put(root, "tooling/core/a.mts", "export const a = 1;\n");
  put(root, "tooling/core/b.mts", "export const b = 1;\n");
  put(root, "tooling/alpha/a.mts", "export const alpha = 1;\n");
  put(root, "tooling/beta/b.mts", "export const beta = 1;\n");
  put(root, "recipes/gamma/g.ts", "g\n");
  put(root, "recipes/delta/d.ts", "d\n");
  put(root, "recipes/frag/f.ts", "f\n");
  put(root, "scripts/registry/cli.mjs", "// the CLI\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-sdlc-cli-"));
  src = join(dir, "src");
  makeSource(src);
  out = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const initProject = (name = "proj") => {
  const code = init(ctx(dir), name, { from: src, install: false, commit: false });
  expect(code).toBe(0);
  return join(dir, name);
};

describe("init", () => {
  it("copies base, writes package.json, the lock and a git repository; installs nothing", () => {
    const p = initProject();
    expect(read(p, "tooling/core/a.mts")).toBe("export const a = 1;\n");
    const pkg = JSON.parse(read(p, "package.json"));
    expect(pkg.name).toBe("proj");
    expect(pkg.scripts).toEqual({
      test: "vitest run",
      sdlc: `node ${join(src, "scripts/registry/cli.mjs")}`,
    });
    expect(pkg.devDependencies).toEqual({ vitest: "4.1.11" });
    const lock = readLock(p);
    expect(Object.keys(lock.items)).toEqual(["base"]);
    // Seed files are the project's from the first byte: not hashed.
    expect(Object.keys(lock.items.base!.files).sort()).toEqual([
      "AGENTS.md",
      "tooling/core/a.mts",
      "tooling/core/b.mts",
    ]);
    expect(lock.source.path).toBe(src);
    expect(existsSync(join(p, ".git"))).toBe(true);
    expect(existsSync(join(p, "node_modules"))).toBe(false);
  });

  it("commits the initial tree when asked", () => {
    const p = join(dir, "c");
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@example.com";
    expect(init(ctx(dir), "c", { from: src, install: false })).toBe(0);
    expect(git(p, "log", "--format=%s")).toBe("Create the project with ai-sdlc init");
    expect(git(p, "status", "--porcelain")).toBe("");
    expect(git(p, "log", "--format=%(trailers:key=No-Item,valueonly)").trim()).toMatch(
      /^created by ai-sdlc init/,
    );
  });

  it("refuses a directory that is not empty", () => {
    put(dir, "full/x", "x\n");
    expect(init(ctx(dir), "full", { from: src, install: false })).toBe(1);
    expect(out.join("\n")).toMatch(/is not empty/);
  });

  it("refuses a source with no registry", () => {
    expect(init(ctx(dir), "p", { from: join(dir, "nowhere"), install: false })).toBe(1);
    expect(out.join("\n")).toMatch(/has no registry\.json/);
  });
});

describe("add", () => {
  it("installs an item and what it requires, merging package.json, config, .gitignore and the workspace", () => {
    const p = initProject();
    out = [];
    expect(add(ctx(p), ["beta"], {})).toBe(0);
    expect(read(p, "tooling/alpha/a.mts")).toBe("export const alpha = 1;\n");
    expect(read(p, "tooling/beta/b.mts")).toBe("export const beta = 1;\n");
    expect(JSON.parse(read(p, "package.json")).scripts.alpha).toBe("node tooling/alpha/a.mts");
    expect(JSON.parse(read(p, "sdlc.config.json")).ci.steps).toEqual([
      { name: "alpha", run: "a", applies: "always" },
    ]);
    expect(read(p, ".gitignore")).toBe("node_modules/\n.alpha/\n");
    expect(read(p, "pnpm-workspace.yaml")).toContain("onlyBuiltDependencies:\n  - esbuild");
    expect(Object.keys(readLock(p).items).sort()).toEqual(["alpha", "base", "beta"]);
    expect(out.join("\n")).toContain("alpha: Configure alpha.");
  });

  it("is idempotent: a second add changes nothing", () => {
    const p = initProject();
    add(ctx(p), ["alpha"], {});
    const before = [read(p, "package.json"), read(p, LOCK_FILE), read(p, "sdlc.config.json")];
    out = [];
    expect(add(ctx(p), ["alpha"], {})).toBe(0);
    expect([read(p, "package.json"), read(p, LOCK_FILE), read(p, "sdlc.config.json")]).toEqual(
      before,
    );
    expect(out.join("\n")).toMatch(/already installed/);
  });

  it("refuses to overwrite a file that differs, and writes nothing", () => {
    const p = initProject();
    put(p, "tooling/beta/b.mts", "mine\n");
    out = [];
    expect(add(ctx(p), ["beta"], {})).toBe(1);
    expect(out.join("\n")).toMatch(/tooling\/beta\/b\.mts exists here with other content/);
    expect(existsSync(join(p, "tooling/alpha/a.mts"))).toBe(false);
    expect(read(p, "tooling/beta/b.mts")).toBe("mine\n");
    expect(Object.keys(readLock(p).items)).toEqual(["base"]);
  });

  it("accepts a file that is already there byte for byte", () => {
    const p = initProject();
    put(p, "tooling/alpha/a.mts", "export const alpha = 1;\n");
    expect(add(ctx(p), ["alpha"], {})).toBe(0);
  });

  it("refuses an item that conflicts with an installed one", () => {
    const p = initProject();
    expect(add(ctx(p), ["gamma"], {})).toBe(0);
    out = [];
    expect(add(ctx(p), ["delta"], {})).toBe(1);
    expect(out.join("\n")).toMatch(/delta conflicts with gamma/);
  });

  it("refuses a package fragment whose package.json is not there, then accepts it once it is", () => {
    const p = initProject();
    expect(add(ctx(p), ["frag"], {})).toBe(1);
    expect(out.join("\n")).toMatch(/apps\/web\/package\.json, which neither exists nor arrives/);
    put(p, "apps/web/package.json", json({ name: "@app/web" }));
    expect(add(ctx(p), ["frag"], {})).toBe(0);
    expect(JSON.parse(read(p, "apps/web/package.json")).dependencies).toEqual({ zod: "4.1.0" });
  });

  it("keeps a script the project changed, and says so", () => {
    const p = initProject();
    const pkg = JSON.parse(read(p, "package.json"));
    pkg.scripts.alpha = "mine";
    put(p, "package.json", json(pkg));
    out = [];
    expect(add(ctx(p), ["alpha"], {})).toBe(0);
    expect(JSON.parse(read(p, "package.json")).scripts.alpha).toBe("mine");
    expect(out.join("\n")).toMatch(/kept package\.json scripts\.alpha: kept "mine"/);
  });

  it("refuses an unknown item, and a directory that is not a project", () => {
    const p = initProject();
    expect(add(ctx(p), ["nope"], {})).toBe(1);
    expect(out.join("\n")).toMatch(/no item named "nope"/);
    expect(add(ctx(dir), ["alpha"], {})).toBe(1);
    expect(out.join("\n")).toMatch(/no sdlc\.lock\.json here or above/);
  });
});

describe("list", () => {
  it("shows every item and which are installed", () => {
    const p = initProject();
    add(ctx(p), ["alpha"], {});
    out = [];
    expect(list(ctx(p), {})).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/alpha\s+module\s+local\s+-/);
    expect(text).toMatch(/beta\s+module\s+-\s+alpha/);
  });
});

describe("diff and update", () => {
  /** A project with alpha and core installed from a git source, then both sides moved. */
  function moved() {
    git(dir, "init", "-q", src);
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", "v1");
    const p = initProject();
    add(ctx(p), ["alpha"], {});
    // here: a local edit to b.mts and AGENTS.md
    put(p, "tooling/core/b.mts", "export const b = 'mine';\n");
    put(p, "AGENTS.md", "# agents, ours\n");
    // upstream: a.mts changed, b.mts changed, AGENTS.md unchanged, c.mts new, alpha changed
    put(src, "tooling/core/a.mts", "export const a = 2;\n");
    put(src, "tooling/core/b.mts", "export const b = 2;\n");
    put(src, "tooling/core/c.mts", "export const c = 1;\n");
    const reg = JSON.parse(read(src, "registry.json"));
    reg.items.base.package.scripts.test = "vitest run --passWithNoTests";
    reg.items.base.package.scripts.lint = "eslint .";
    put(src, "registry.json", json(reg));
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", "v2");
    return p;
  }

  it("diff classifies each file and shows the upstream change to a file changed on both sides", () => {
    const p = moved();
    out = [];
    expect(diff(ctx(p), "base", {})).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/changed-upstream\s+tooling\/core\/a\.mts/);
    expect(text).toMatch(/both-changed\s+tooling\/core\/b\.mts/);
    expect(text).toMatch(/locally-modified\s+AGENTS\.md/);
    expect(text).toMatch(/added-upstream\s+tooling\/core\/c\.mts/);
    // The base came from the source's own history: the upstream change, not ours.
    expect(text).toMatch(/--- tooling\/core\/b\.mts as copied/);
    expect(text).toMatch(/-export const b = 1;/);
    expect(text).toMatch(/\+export const b = 2;/);
    expect(text).toMatch(/merge changed\s+package\.json scripts\.test/);
    expect(text).toMatch(/merge added\s+package\.json scripts\.lint/);
  });

  it("update applies upstream only to untouched files, and never overwrites a local edit", () => {
    const p = moved();
    out = [];
    expect(update(ctx(p), "base", {})).toBe(0);
    expect(read(p, "tooling/core/a.mts")).toBe("export const a = 2;\n");
    expect(read(p, "tooling/core/c.mts")).toBe("export const c = 1;\n");
    expect(read(p, "tooling/core/b.mts")).toBe("export const b = 'mine';\n");
    expect(read(p, "AGENTS.md")).toBe("# agents, ours\n");
    const pkg = JSON.parse(read(p, "package.json"));
    expect(pkg.scripts.test).toBe("vitest run --passWithNoTests");
    expect(pkg.scripts.lint).toBe("eslint .");
    expect(out.join("\n")).toMatch(/1 file\(s\) changed both here and upstream/);
    // Still waiting on the hand merge.
    out = [];
    diff(ctx(p), "base", {});
    expect(out.join("\n")).toMatch(/both-changed\s+tooling\/core\/b\.mts/);
    expect(out.join("\n")).not.toMatch(/changed-upstream/);
  });

  it("a file left behind by one update still diffs against the version it was copied at", () => {
    const p = moved();
    update(ctx(p), "base", {});
    put(src, "tooling/core/b.mts", "export const b = 3;\n");
    git(src, "commit", "-q", "-am", "v3");
    out = [];
    diff(ctx(p), "base", {});
    const text = out.join("\n");
    expect(text).toMatch(/--- tooling\/core\/b\.mts as copied/);
    expect(text).toMatch(/-export const b = 1;/);
    expect(text).toMatch(/\+export const b = 3;/);
    expect(readLock(p).items.base!.files["tooling/core/b.mts"]!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readLock(p).items.base!.files["tooling/core/a.mts"]!.commit).toBeUndefined();
  });

  it("update --accept records a hand merge; the file then reads as the project's", () => {
    const p = moved();
    update(ctx(p), "base", {});
    put(p, "tooling/core/b.mts", "export const b = 2; // and ours\n");
    expect(update(ctx(p), "base", { accept: ["tooling/core/b.mts"] })).toBe(0);
    out = [];
    diff(ctx(p), "base", {});
    expect(out.join("\n")).toMatch(/locally-modified\s+tooling\/core\/b\.mts/);
    expect(update(ctx(p), "base", { accept: ["tooling/core/a.mts"] })).toBe(1);
  });

  it("keeps a script value the project changed, and deletes an untouched file removed upstream", () => {
    const p = moved();
    const pkg = JSON.parse(read(p, "package.json"));
    pkg.scripts.test = "vitest run --project unit";
    put(p, "package.json", json(pkg));
    rmSync(join(src, "tooling/core/a.mts"));
    git(src, "commit", "-q", "-am", "v3");
    out = [];
    expect(update(ctx(p), "base", {})).toBe(0);
    expect(JSON.parse(read(p, "package.json")).scripts.test).toBe("vitest run --project unit");
    expect(out.join("\n")).toMatch(
      /kept\s+package\.json scripts\.test: kept "vitest run --project unit"/,
    );
    expect(existsSync(join(p, "tooling/core/a.mts"))).toBe(false);
  });

  it("refuses an item that is not installed", () => {
    const p = initProject();
    expect(diff(ctx(p), "alpha", {})).toBe(1);
    expect(update(ctx(p), "alpha", {})).toBe(1);
  });
});

describe("the source", () => {
  it("fetches a ref of a git repository into the cache, by commit", () => {
    git(dir, "init", "-q", "-b", "main", src);
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", "v1");
    git(src, "tag", "v0.1.0");
    const r = fetchSource(`file://${src}`, "v0.1.0", join(dir, "cache"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id.commit).toBe(git(src, "rev-parse", "HEAD"));
    expect(r.dir).toBe(join(dir, "cache", r.id.commit as string));
    expect(read(r.dir, "AGENTS.md")).toBe("# agents\n");
  });

  it("could not ask: a repository it cannot reach is not 'nothing to update'", () => {
    const r = resolveSource({
      repo: `file://${join(dir, "missing")}`,
      ref: "main",
      cwd: dir,
      cache: join(dir, "cache"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.couldNotAsk).toBe(true);
    const code = init(ctx(dir), "p", {
      repo: `file://${join(dir, "missing")}`,
      ref: "main",
      install: false,
    });
    expect(code).toBe(2);
  });

  it("init from a git ref records repo, ref and commit, and pins the sdlc script to it", () => {
    git(dir, "init", "-q", "-b", "main", src);
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", "v1");
    git(src, "tag", "v0.1.0");
    const repo = `file://${src}`;
    expect(init(ctx(dir), "g", { repo, ref: "v0.1.0", install: false, commit: false })).toBe(0);
    const lock = readLock(join(dir, "g"));
    expect(lock.source).toEqual({ repo, ref: "v0.1.0", commit: git(src, "rev-parse", "HEAD") });
    expect(JSON.parse(read(join(dir, "g"), "package.json")).scripts.sdlc).toBe(
      `pnpm dlx git+${repo}#v0.1.0`,
    );
  });
});

describe("the command line", () => {
  it("parses options and refuses unknown ones", () => {
    expect(parseArgs(["init", "x", "--from", "s", "--no-install"])).toMatchObject({
      command: "init",
      args: ["x"],
      from: "s",
      install: false,
    });
    expect(parseArgs(["add", "--bogus"]).bad).toEqual(["unknown option --bogus"]);
    expect(parseArgs(["add", "--from"]).bad).toEqual(["--from needs a value"]);
    expect(main(["frobnicate"])).toBe(1);
    expect(main(["init"])).toBe(1);
  });
});
