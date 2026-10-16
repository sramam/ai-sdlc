/**
 * The third-party check: green on this repository, and tripped one way at a
 * time on a small tree built here.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSkillLinks } from "../../tooling/core/src/skill-links.mjs";
import { checkThirdParty, frontmatter, globMatch } from "./third-party.mts";

const REPO = join(import.meta.dirname, "..", "..");

describe("this repository", () => {
  it("passes: copies untouched, every entry wrapped, every skill linked", () => {
    expect(checkThirdParty(REPO)).toEqual([]);
  });
});

let dir: string;
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const UPSTREAM_SKILL =
  "---\nname: tdd\ndescription: >-\n  Red, green,\n  refactor.\n---\n\n# TDD\n";
const WRAPPER = (
  description = "Red, green, refactor.",
  body = "Follow [it](../../3rdparty/up/skills/tdd/SKILL.md).",
) =>
  `---\nname: tdd\ndescription: ${description}\nmetadata:\n  upstream: .agents/3rdparty/up/skills/tdd/SKILL.md\n---\n\n${body}\n`;

function source(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  for (const [p, text] of Object.entries(files)) write(`.agents/3rdparty/up/${p}`, text);
  write(
    ".agents/3rdparty/up/SOURCE.json",
    JSON.stringify({
      repo: "https://example.com/up.git",
      ref: "main",
      commit: "a".repeat(40),
      license: "MIT",
      paths: ["skills/"],
      wrap: ["skills/*/SKILL.md"],
      files: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, sha(t)])),
      ...extra,
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "third-party-"));
  source({ "skills/tdd/SKILL.md": UPSTREAM_SKILL });
  write(".agents/skills/tdd/SKILL.md", WRAPPER());
  ensureSkillLinks(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tripped", () => {
  it("is green as built", () => {
    expect(checkThirdParty(dir)).toEqual([]);
  });

  it("an edited third-party file", () => {
    write(".agents/3rdparty/up/skills/tdd/SKILL.md", `${UPSTREAM_SKILL}\nedited\n`);
    expect(checkThirdParty(dir).join("\n")).toMatch(/edited — third-party files are never changed/);
  });

  it("a file added under a source by hand", () => {
    write(".agents/3rdparty/up/skills/tdd/notes.md", "ours\n");
    expect(checkThirdParty(dir).join("\n")).toMatch(/notes\.md: not from upstream/);
  });

  it("an upstream entry with no wrapper", () => {
    rmSync(join(dir, ".agents/skills/tdd"), { recursive: true });
    ensureSkillLinks(dir);
    expect(checkThirdParty(dir).join("\n")).toMatch(/skills\/tdd\/SKILL\.md: no wrapper/);
  });

  it("an entry deliberately unwrapped needs no wrapper, and may not have one", () => {
    source(
      { "skills/tdd/SKILL.md": UPSTREAM_SKILL },
      { unwrapped: { "skills/tdd/SKILL.md": "not used" } },
    );
    expect(checkThirdParty(dir).join("\n")).toMatch(/lists as unwrapped/);
    rmSync(join(dir, ".agents/skills/tdd"), { recursive: true });
    ensureSkillLinks(dir);
    expect(checkThirdParty(dir)).toEqual([]);
  });

  it("a wrapper whose description drifted from upstream's", () => {
    write(".agents/skills/tdd/SKILL.md", WRAPPER("Our own words."));
    expect(checkThirdParty(dir).join("\n")).toMatch(/description differs/);
  });

  it("…unless it says why", () => {
    write(
      ".agents/skills/tdd/SKILL.md",
      WRAPPER("Our own words.").replace(
        "metadata:\n",
        "metadata:\n  own-description: it routes differently here\n",
      ),
    );
    expect(checkThirdParty(dir)).toEqual([]);
  });

  it("a wrapper that does not link to its upstream", () => {
    write(".agents/skills/tdd/SKILL.md", WRAPPER(undefined, "Do what you think best."));
    expect(checkThirdParty(dir).join("\n")).toMatch(/does not link to its upstream/);
  });

  it("a wrapper naming an entry that does not exist", () => {
    write(
      ".agents/skills/tdd/SKILL.md",
      WRAPPER().replace("skills/tdd/SKILL.md\n---", "skills/gone/SKILL.md\n---"),
    );
    expect(checkThirdParty(dir).join("\n")).toMatch(/is not an upstream entry/);
  });

  it("a skill Claude Code cannot see, and a stray link", () => {
    rmSync(join(dir, ".claude/skills/tdd"));
    expect(checkThirdParty(dir).join("\n")).toMatch(/\.claude\/skills\/tdd: missing/);
    symlinkSync("../../.agents/skills/tdd", join(dir, ".claude/skills/tdd"));
    symlinkSync("../../.agents/skills/old", join(dir, ".claude/skills/old"));
    expect(checkThirdParty(dir).join("\n")).toMatch(
      /\.claude\/skills\/old: no \.agents\/skills\/old/,
    );
  });

  it("a real directory where a link belongs", () => {
    rmSync(join(dir, ".claude/skills/tdd"));
    write(".claude/skills/tdd/SKILL.md", "x");
    expect(checkThirdParty(dir).join("\n")).toMatch(/not a symlink/);
  });
});

describe("ensureSkillLinks", () => {
  it("creates missing links, removes ones whose skill is gone, keeps the project's own", () => {
    write(".agents/skills/new/SKILL.md", "x");
    write(".claude/skills/mine/SKILL.md", "x");
    symlinkSync("../../.agents/skills/gone", join(dir, ".claude/skills/gone"));
    const r = ensureSkillLinks(dir);
    expect(r.created).toEqual([".claude/skills/new"]);
    expect(r.removed).toEqual([".claude/skills/gone"]);
    expect(r.failed).toEqual([]);
  });
});

describe("frontmatter", () => {
  it("folds block scalars and reads metadata", () => {
    const fm = frontmatter(
      "---\nname: x\ndescription: |\n  one\n  two\nmetadata:\n  upstream: a/b.md\n  own-description: why\nlicense: MIT\n---\nbody\n",
    );
    expect(fm.fields).toEqual({ name: "x", description: "one two", license: "MIT" });
    expect(fm.metadata).toEqual({ upstream: "a/b.md", "own-description": "why" });
    expect(fm.body).toBe("body\n");
  });

  it("strips quotes", () => {
    expect(frontmatter('---\ndescription: "quoted: yes"\n---\n').fields.description).toBe(
      "quoted: yes",
    );
  });
});

describe("globMatch", () => {
  it("matches * within one segment only", () => {
    expect(globMatch("skills/*/SKILL.md", "skills/tdd/SKILL.md")).toBe(true);
    expect(globMatch("skills/*/SKILL.md", "skills/a/b/SKILL.md")).toBe(false);
    expect(globMatch(".claude/commands/*.md", ".claude/commands/build.md")).toBe(true);
  });
});
