import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSource,
  checkSourcesManifest,
  listSources,
  parseManifest,
  sha256,
} from "./sources-manifest.mts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): { root: string; sources: string } {
  const root = mkdtempSync(join(tmpdir(), "sdlc-sources-"));
  roots.push(root);
  const sources = join(root, "docs/requirements/sources");
  mkdirSync(sources, { recursive: true });
  writeFileSync(join(sources, ".gitkeep"), "");
  return { root, sources };
}

describe("checkSourcesManifest", () => {
  it("passes an empty sources/ with no MANIFEST, and ignores dotfiles", () => {
    const { root } = project();
    expect(checkSourcesManifest(root)).toEqual({ state: "ok", checked: 0, problems: [] });
  });

  it("passes files recorded by --add, including nested ones", () => {
    const { root, sources } = project();
    writeFileSync(join(sources, "brief.md"), "the brief\n");
    mkdirSync(join(sources, "calls"));
    writeFileSync(join(sources, "calls/one.txt"), "call\n");
    expect(addSource(root, join(sources, "brief.md")).ok).toBe(true);
    expect(addSource(root, join(sources, "calls/one.txt")).ok).toBe(true);
    expect(listSources(sources)).toEqual(["brief.md", "calls/one.txt"]);
    expect(checkSourcesManifest(root)).toMatchObject({ state: "ok", checked: 2 });
    const text = readFileSync(join(sources, "MANIFEST"), "utf8");
    expect(text).toBe(
      `${sha256(join(sources, "brief.md"))}  brief.md\n${sha256(join(sources, "calls/one.txt"))}  calls/one.txt\n`,
    );
  });

  it("fails a file with no line, an edited file, a deleted file, a bad line and a duplicate", () => {
    const { root, sources } = project();
    writeFileSync(join(sources, "a.md"), "a\n");
    writeFileSync(join(sources, "b.md"), "b\n");
    addSource(root, join(sources, "a.md"));
    addSource(root, join(sources, "b.md"));
    writeFileSync(join(sources, "unrecorded.md"), "u\n");
    writeFileSync(join(sources, "a.md"), "edited by sed -i\n");
    rmSync(join(sources, "b.md"));
    appendFileSync(join(sources, "MANIFEST"), "not a line\n");
    appendFileSync(join(sources, "MANIFEST"), `${sha256(join(sources, "unrecorded.md"))}  x.md\n`);
    appendFileSync(join(sources, "MANIFEST"), `${sha256(join(sources, "unrecorded.md"))}  x.md\n`);
    const r = checkSourcesManifest(root);
    expect(r.state).toBe("refused");
    const all = r.problems.join("\n");
    expect(all).toMatch(/unrecorded\.md has no MANIFEST line/);
    expect(all).toMatch(/a\.md has changed/);
    expect(all).toMatch(/b\.md is in MANIFEST but not on disk/);
    expect(all).toMatch(/line 3 is not/);
    expect(all).toMatch(/x\.md is recorded twice/);
  });

  it("follows a configured requirements directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sdlc-sources-cfg-"));
    roots.push(root);
    mkdirSync(join(root, "spec/sources"), { recursive: true });
    writeFileSync(join(root, "spec/sources/x.md"), "x");
    expect(checkSourcesManifest(root, "spec").state).toBe("refused");
    expect(addSource(root, "spec/sources/x.md", "spec").ok).toBe(true);
    expect(checkSourcesManifest(root, "spec").state).toBe("ok");
  });
});

describe("addSource", () => {
  it("is idempotent for an unchanged file and refuses to re-record a changed one", () => {
    const { root, sources } = project();
    writeFileSync(join(sources, "a.md"), "a\n");
    expect(addSource(root, join(sources, "a.md")).ok).toBe(true);
    expect(addSource(root, join(sources, "a.md"))).toMatchObject({
      ok: true,
      message: expect.stringContaining("already"),
    });
    writeFileSync(join(sources, "a.md"), "b\n");
    expect(addSource(root, join(sources, "a.md"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("immutable"),
    });
    expect(parseManifest(readFileSync(join(sources, "MANIFEST"), "utf8")).lines).toHaveLength(1);
  });

  it("refuses a path outside sources/, MANIFEST itself, a dotfile and a missing file", () => {
    const { root, sources } = project();
    writeFileSync(join(root, "elsewhere.md"), "x");
    expect(addSource(root, join(root, "elsewhere.md")).ok).toBe(false);
    expect(addSource(root, join(sources, "MANIFEST")).ok).toBe(false);
    expect(addSource(root, join(sources, ".gitkeep")).ok).toBe(false);
    expect(addSource(root, join(sources, "missing.md")).ok).toBe(false);
  });
});
