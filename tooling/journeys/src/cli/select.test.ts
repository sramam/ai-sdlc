import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpecName, selectSpecs } from "./select.mts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "journeys-select-")));
mkdirSync(join(root, "e2e"));
for (const f of [
  "j2-paying.visitor.spec.ts",
  "j23-refunds.visitor.spec.ts",
  "j2-paying.common.spec.mts",
  "fixtures.spec.ts",
]) {
  writeFileSync(join(root, "e2e", f), "");
}

describe("selecting a walk by journey and persona", () => {
  it("parses the journey and persona out of a spec name", () => {
    expect(parseSpecName("j2-paying.visitor.spec.ts")).toEqual({
      journey: "J2",
      slug: "paying",
      persona: "visitor",
    });
    expect(parseSpecName("fixtures.spec.ts")).toBeNull();
  });

  it("resolves to paths, so J2 is never a prefix of J23", () => {
    expect(selectSpecs(["--journey", "j2", "--reporter=line"], root, "e2e")).toEqual({
      files: ["e2e/j2-paying.common.spec.mts", "e2e/j2-paying.visitor.spec.ts"],
      rest: ["--reporter=line"],
      asked: { journey: "J2" },
    });
    expect(selectSpecs(["--journey=J2", "--persona=common"], root, "e2e").files).toEqual([
      "e2e/j2-paying.common.spec.mts",
    ]);
  });

  it("passes everything through when nothing is asked", () => {
    expect(selectSpecs(["--grep", "x"], root, "e2e")).toEqual({
      files: [],
      rest: ["--grep", "x"],
      asked: {},
    });
  });

  it("throws rather than widening to the whole suite", () => {
    expect(() => selectSpecs(["--journey", "J7"], root, "e2e")).toThrow(
      /JOURNEY-060[\s\S]*Journeys: J2 J23/,
    );
  });
});
