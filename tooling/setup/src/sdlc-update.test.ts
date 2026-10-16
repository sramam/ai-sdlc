import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STARTER_MODULES, STARTER_SKILLS } from "../../core/src/config.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult, ScriptedCall } from "../../core/src/exec.mts";
import { MANIFEST_FILE, VERSION_FILE, parseManifest } from "../../core/src/manifest.mts";
import type { StarterManifest } from "../../core/src/manifest.mts";
import {
  MIGRATIONS_FILE,
  UPSTREAM_PATHS,
  migrationSections,
  newerSections,
  parseArgs,
  runUpdate,
} from "./sdlc-update.mts";
import type { UpdateOptions } from "./sdlc-update.mts";

const REPO = join(import.meta.dirname, "..", "..", "..");

type Rule = [RegExp | string, ExecResult | ((c: ScriptedCall) => ExecResult)];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sdlc-update-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (path: string) => readFileSync(join(root, path), "utf8");

const MANIFEST: StarterManifest = {
  version: "0.3.0",
  owned: [
    { path: "tooling/ci/", kind: "replace" },
    { path: "tooling/journeys/", kind: "replace" },
    { path: "docs/kit/", kind: "replace" },
    { path: ".claude/settings.json", kind: "merge-json" },
    {
      path: "package.json",
      kind: "merge-json",
      keys: { scripts: ["ci:local"], devDependencies: ["vitest"] },
    },
    { path: ".gitignore", kind: "merge-lines" },
  ],
};

const MIGRATIONS = `# Migrations

## 0.1.0

Initial.

## 0.2.0

Rename X to Y.

## 0.3.0

Drop Z.
`;

/** Files at starter/main. */
const STARTER: Record<string, string> = {
  [MANIFEST_FILE]: JSON.stringify(MANIFEST),
  [MIGRATIONS_FILE]: MIGRATIONS,
  ".claude/settings.json": JSON.stringify({
    permissions: { allow: ["Bash(git *)", "Bash(pnpm *)"], deny: ["Read(**/.env)"] },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "node tooling/guards/a.mts" }] },
      ],
    },
  }),
  "package.json": JSON.stringify({
    name: "ai-sdlc",
    scripts: { "ci:local": "node tooling/ci/src/ci-local.mts", lint: "eslint ." },
    devDependencies: { vitest: "^4.0.0", eslint: "^10.0.0" },
  }),
  ".gitignore": "node_modules/\n.ci-local/\n\n# Secrets\n.env\n.dev.vars\n",
};

function rules(over: Rule[] = [], starter: Record<string, string> = STARTER): Rule[] {
  return [
    ...over,
    ["git status --porcelain", result(0, "")],
    ["git remote get-url starter", result(0, "https://github.com/acme/starter.git\n")],
    ["git fetch --quiet starter", result(0)],
    [/^git rev-parse --verify --quiet starter\/main/, result(0, "1234567890abcdef\n")],
    [
      /^git cat-file -e starter\/main:/,
      (c) => result(c.args[2]!.slice("starter/main:".length) in starter ? 0 : 128),
    ],
    [
      /^git show starter\/main:/,
      (c) => {
        const p = c.args[1]!.slice("starter/main:".length);
        return p in starter ? result(0, starter[p]) : result(128, "", "fatal: path does not exist");
      },
    ],
    [/^git ls-tree --name-only starter\/main -- tooling\/journeys$/, result(0, "")],
    [/^git ls-files -- tooling\/journeys\/$/, result(0, "")],
    [/^git ls-tree/, result(0, "x\n")],
    [/^git ls-files/, result(0, "")],
    [/^git diff --quiet starter\/main -- docs\/kit\/$/, result(0)],
    [/^git diff --quiet/, result(1)],
    [/^git restore/, result(0)],
    [/^git diff --stat/, result(0, " tooling/ci/src/ci-local.mts | 4 ++--\n 1 file changed\n")],
    [
      /^git status --porcelain --untracked-files=all/,
      result(0, " M tooling/ci/src/ci-local.mts\n M .gitignore\n"),
    ],
  ];
}

const OPTS: UpdateOptions = { ref: "starter/main", dryRun: false, replaced: [], configVersion: 1 };

async function run(r: Rule[] = rules(), opts: Partial<UpdateOptions> = {}) {
  const exec = scriptedExec(r);
  const lines: string[] = [];
  const code = await runUpdate({ exec, root, log: (l) => lines.push(l) }, { ...OPTS, ...opts });
  return { code, exec, out: lines.join("\n") };
}

const PROJECT_SETTINGS = {
  attribution: { commit: "Co-Authored-By: x" },
  permissions: { allow: ["Bash(git *)", "Bash(make *)"], deny: [] },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "node scripts/mine.mts" }] },
    ],
  },
};

function projectFiles() {
  write(".claude/settings.json", `${JSON.stringify(PROJECT_SETTINGS, null, 2)}\n`);
  write(
    "package.json",
    `${JSON.stringify(
      {
        name: "acme",
        scripts: { "ci:local": "old", lint: "biome check" },
        devDependencies: { vitest: "^3.0.0", eslint: "^9.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  write(".gitignore", "node_modules/\n.env\n# ours\n/build\n");
  write(VERSION_FILE, "0.1.0\n");
}

describe("sdlc:update with a manifest", () => {
  it("replaces, merges, records the version and prints the newer migration notes — staging nothing", async () => {
    projectFiles();
    const { code, exec, out } = await run();
    expect(code, out).toBe(0);

    const restore = exec.calls.find((c) => c.args[0] === "restore");
    expect(restore?.args).toEqual([
      "restore",
      "--source=starter/main",
      "--worktree",
      "--",
      "tooling/ci/",
    ]);
    expect(out).toMatch(/n\/a\s+replace\s+tooling\/journeys\/\s+\(on neither side\)/);
    expect(out).toMatch(/unchanged\s+replace\s+docs\/kit\//);

    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.permissions.allow).toEqual(["Bash(git *)", "Bash(make *)", "Bash(pnpm *)"]);
    expect(settings.permissions.deny).toEqual(["Read(**/.env)"]);
    expect(settings.attribution).toEqual(PROJECT_SETTINGS.attribution);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks.map((h: { command: string }) => h.command)).toEqual([
      "node scripts/mine.mts",
      "node tooling/guards/a.mts",
    ]);

    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("acme");
    expect(pkg.scripts).toEqual({
      "ci:local": "node tooling/ci/src/ci-local.mts",
      lint: "biome check",
    });
    expect(pkg.devDependencies).toEqual({ vitest: "^4.0.0", eslint: "^9.0.0" });
    expect(out).toMatch(/run `pnpm install`/);

    expect(read(".gitignore")).toBe(
      "node_modules/\n.ci-local/\n# Secrets\n.env\n.dev.vars\n# ours\n/build\n",
    );
    expect(read(VERSION_FILE)).toBe("0.3.0\n");

    expect(out).toMatch(/Migration notes .* since 0\.1\.0/);
    expect(out).toMatch(/## 0\.2\.0[\s\S]*Rename X to Y[\s\S]*## 0\.3\.0[\s\S]*Drop Z/);
    expect(out).not.toMatch(/## 0\.1\.0/);
    expect(exec.calls.some((c) => ["add", "commit", "stash"].includes(c.args[0] ?? ""))).toBe(
      false,
    );
  });

  it("is idempotent: a second run against the result merges nothing", async () => {
    projectFiles();
    await run();
    const before = [".claude/settings.json", "package.json", ".gitignore"].map(read);
    const { out } = await run(rules([[/^git diff --quiet/, result(0)]]));
    expect([".claude/settings.json", "package.json", ".gitignore"].map(read)).toEqual(before);
    expect(out).toMatch(/already current at 0\.3\.0/);
  });

  it("--dry-run prints the plan per path and writes nothing", async () => {
    projectFiles();
    const snapshot = [".claude/settings.json", "package.json", ".gitignore", VERSION_FILE].map(
      read,
    );
    const { code, exec, out } = await run(rules(), { dryRun: true });
    expect(code).toBe(0);
    expect(out).toMatch(/replace\s+replace\s+tooling\/ci\//);
    expect(out).toMatch(/merge\s+merge-json\s+\.claude\/settings\.json/);
    expect(out).toMatch(/merge\s+merge-lines\s+\.gitignore/);
    expect(out).toMatch(
      /dry run: 1 to replace, 3 to merge, \.sdlc-version 0\.1\.0 → 0\.3\.0; nothing written/,
    );
    expect(out).toMatch(/Drop Z/);
    expect([".claude/settings.json", "package.json", ".gitignore", VERSION_FILE].map(read)).toEqual(
      snapshot,
    );
    expect(exec.calls.some((c) => c.args[0] === "restore")).toBe(false);
  });

  it("skips a module the project replaced", async () => {
    projectFiles();
    const { exec, out } = await run(rules(), { replaced: ["ci"] });
    expect(out).toMatch(/skip\s+replace\s+tooling\/ci\/\s+\(replaced by this project\)/);
    expect(exec.calls.some((c) => c.args[0] === "restore")).toBe(false);
  });

  it("creates a merge-lines file the project lacks", async () => {
    projectFiles();
    rmSync(join(root, ".gitignore"));
    await run();
    expect(read(".gitignore")).toBe("node_modules/\n.ci-local/\n# Secrets\n.env\n.dev.vars\n");
  });

  it("with no .sdlc-version, prints every section up to the starter's", async () => {
    projectFiles();
    rmSync(join(root, VERSION_FILE));
    const { out } = await run(rules(), { dryRun: true });
    expect(out).toMatch(/this project unknown/);
    expect(out).toMatch(/## 0\.1\.0[\s\S]*## 0\.2\.0[\s\S]*## 0\.3\.0/);
  });

  it("refuses a project whose configVersion is behind minConfigVersion, printing the migration", async () => {
    projectFiles();
    const starter = {
      ...STARTER,
      [MANIFEST_FILE]: JSON.stringify({ ...MANIFEST, minConfigVersion: 2 }),
    };
    const { code, exec, out } = await run(rules([], starter));
    expect(code).toBe(1);
    expect(out).toMatch(/needs configVersion 2 and sdlc\.config\.json is at 1/);
    expect(out).toMatch(/Rename X to Y/);
    expect(exec.calls.some((c) => c.args[0] === "restore")).toBe(false);
    expect(read(VERSION_FILE)).toBe("0.1.0\n");
  });

  it("refuses an invalid manifest, and a project file that is not JSON", async () => {
    projectFiles();
    const bad = { ...STARTER, [MANIFEST_FILE]: '{"version":"one","owned":[]}' };
    const a = await run(rules([], bad));
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/version: "one" does not match/);

    write(".claude/settings.json", "{ nope");
    const b = await run();
    expect(b.code).toBe(1);
    expect(b.out).toMatch(/\.claude\/settings\.json: the project's file is not valid JSON/);
  });

  it("falls back to the derived paths when the starter has no manifest", async () => {
    const { code, exec, out } = await run(rules([], { [MIGRATIONS_FILE]: MIGRATIONS }));
    expect(code).toBe(0);
    expect(out).toMatch(/manifest\s+none at starter\/main/);
    const restore = exec.calls.find((c) => c.args[0] === "restore");
    expect(restore?.args).toContain(".claude/skills/land/");
    expect(restore?.args).not.toContain("tooling/journeys/");
    expect(existsSync(join(root, VERSION_FILE))).toBe(false);
  });
});

describe("sdlc:update refusals", () => {
  it("refuses a dirty tree", async () => {
    const { code, out } = await run(
      rules([["git status --porcelain", result(0, " M README.md\n")]]),
    );
    expect(code).toBe(1);
    expect(out).toMatch(/dirty/);
  });

  it("a dry run may look at a dirty tree, and says so", async () => {
    const { code, out } = await run(
      rules([["git status --porcelain", result(0, " M README.md\n")]]),
      { dryRun: true },
    );
    expect(code).toBe(0);
    expect(out).toMatch(/dirty — fine for a dry run/);
  });

  it("could not ask without a starter remote, and says how to add one", async () => {
    const { code, out } = await run(
      rules([["git remote get-url starter", result(2, "", "error: No such remote 'starter'")]]),
    );
    expect(code).toBe(2);
    expect(out).toMatch(/could not ask: no `starter` remote/);
    expect(out).toMatch(/git remote add starter https:\/\/github\.com\/<org>\/<starter>\.git/);
  });

  it("parseArgs", () => {
    expect(parseArgs([])).toEqual({ ref: "starter/main", dryRun: false });
    expect(parseArgs(["--dry-run", "--ref", "up/x"])).toEqual({ ref: "up/x", dryRun: true });
    expect(parseArgs(["--bogus"])).toHaveProperty("error");
  });
});

describe("migration notes", () => {
  it("sections are read by version, and only the unseen ones are newer", () => {
    expect(migrationSections(MIGRATIONS).map((s) => s.version)).toEqual([
      "0.1.0",
      "0.2.0",
      "0.3.0",
    ]);
    expect(newerSections(MIGRATIONS, "0.1.0", "0.2.0").map((s) => s.version)).toEqual(["0.2.0"]);
    expect(newerSections(MIGRATIONS, "0.3.0", "0.3.0")).toEqual([]);
  });
});

describe("the starter's own manifest", () => {
  const manifest = parseManifest(readFileSync(join(REPO, MANIFEST_FILE), "utf8"));
  const replace = new Set(manifest.owned.filter((o) => o.kind === "replace").map((o) => o.path));

  it("owns every starter module and skill, docs/kit/ and itself", () => {
    for (const m of STARTER_MODULES) expect(replace).toContain(`tooling/${m}/`);
    for (const s of STARTER_SKILLS) expect(replace).toContain(`.claude/skills/${s}/`);
    expect(replace).toContain("docs/kit/");
    expect(replace).toContain(MANIFEST_FILE);
  });

  it("names only paths that exist, and package keys the root package.json has", () => {
    for (const o of manifest.owned) expect(existsSync(join(REPO, o.path)), o.path).toBe(true);
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    const keys = manifest.owned.find((o) => o.path === "package.json")?.keys ?? {};
    for (const [section, names] of Object.entries(keys))
      for (const n of names) expect(pkg[section]?.[n], `${section}.${n}`).toBeDefined();
  });

  it("its version is .sdlc-version's, and MIGRATIONS.md has a section for it", () => {
    expect(readFileSync(join(REPO, VERSION_FILE), "utf8").trim()).toBe(manifest.version);
    const sections = migrationSections(readFileSync(join(REPO, MIGRATIONS_FILE), "utf8"));
    expect(sections.map((s) => s.version)).toContain(manifest.version);
  });

  it("the derived fallback still covers the modules and skills", () => {
    expect(UPSTREAM_PATHS).toContain("tooling/guards/");
    expect(UPSTREAM_PATHS).toHaveLength(STARTER_MODULES.length + 1 + STARTER_SKILLS.length);
  });
});
