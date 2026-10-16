import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigSync } from "../../core/src/config.mts";
import {
  describeOffences,
  floorProsePatternCheck,
  quotesInLine,
} from "./floor-prose.test-helper.mts";

let root: string;
beforeEach(() => (root = mkdtempSync(join(tmpdir(), "floor-prose-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function doc(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe("quotesInLine", () => {
  const pats = [/(?<![\w#.])\d{1,3}(?:\.\d+)?\s?%/g];
  it("finds a number only near the word", () => {
    expect(quotesInLine("The coverage floor is 92% today.", pats)).toEqual(["92%"]);
    expect(quotesInLine("Uptime was 99% last week.", pats)).toEqual([]);
    expect(quotesInLine(`coverage ${"x".repeat(120)} 92%`, pats)).toEqual([]);
  });
});

describe("floorProsePatternCheck on fixtures", () => {
  it("flags a quoted floor, a figure pair and a bare declared value; ignores the rest", () => {
    doc("docs/a.md", "# A\n\nThe branch floor is 88% for the api.\n");
    doc("docs/nested/b.md", "Coverage stands at 92 / 88 on the merged run.\n");
    doc("docs/c.md", "packages/db has a coverage floor of 97 lines.\n");
    doc("docs/d.md", "See #1038 about the floor. Released in 2026. Coverage is one gate.\n");
    doc("docs/quality/coverage.md", "coverage 91.2% (generated, exempt)\n");
    doc("README.md", "coverage 50% (outside docs/)\n");

    const r = floorProsePatternCheck(root, {
      floors: { "packages/db": { lines: 97, branches: 92 } },
    });
    expect(r.scanned).toEqual(["docs/a.md", "docs/c.md", "docs/d.md", "docs/nested/b.md"]);
    expect(r.offences.map((o) => `${o.file}:${o.line} ${o.quote}`)).toEqual([
      "docs/a.md:3 88%",
      "docs/c.md:1 97",
      "docs/nested/b.md:1 92 / 88",
    ]);
    expect(describeOffences(r)).toContain("docs/a.md:3  88%");
  });

  it("a declared historical quote may stay, and the declaration list is a ratchet", () => {
    const why = "the removed backstop as it stood before it was dropped: past tense, cannot decay";
    doc("docs/history.md", "The old coverage floor of 90/79 was removed rather than lowered.\n");
    const ok = floorProsePatternCheck(root, {
      declared: [{ file: "docs/history.md", text: "90/79", why }],
    });
    expect(ok.offences).toEqual([]);
    expect(ok.staleDeclarations).toEqual([]);

    const stale = floorProsePatternCheck(root, {
      declared: [
        { file: "docs/history.md", text: "93/84", why },
        { file: "docs/history.md", text: "90/79", why: "short" },
      ],
    });
    expect(stale.staleDeclarations).toEqual([
      'docs/history.md no longer contains "93/84": delete its declaration',
      'docs/history.md: "90/79" needs a real reason',
    ]);
  });
});

describe("this repository", () => {
  it("quotes no coverage floor in docs/", () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const r = floorProsePatternCheck(repo, { floors: loadConfigSync(repo).coverage.floors });
    // A sweep that returns nothing would read exactly like success.
    expect(r.scanned.length).toBeGreaterThan(5);
    expect(r.offences, describeOffences(r)).toEqual([]);
    console.log(`  ${r.scanned.length} markdown files under docs/ scanned, no floor quoted`);
  });
});
