import { describe, expect, it } from "vitest";
import { isSignedOff, journeyStatusLine, signedOffIds, withStatusLine } from "./verdict.mts";

/**
 * `.test.ts` so vitest claims it, per the two-runners rule: `.spec.ts` is
 * Playwright's and `.test.ts` is vitest's (see this package's agents.md).
 *
 * Pure arithmetic over strings — no browser, no recordings, no filesystem.
 */

describe("signedOffIds", () => {
  it("reads a linked entry and a bare one alike", () => {
    const md = ["- [J31 Signing In](J31-signing-in/README.md) — released", "- J35 — released"].join(
      "\n",
    );
    expect([...signedOffIds(md)].sort()).toEqual(["J31", "J35"]);
  });

  it("releases nothing from an empty file", () => {
    // The safe direction: a missing file must not read as "QA may take it all".
    expect(signedOffIds("").size).toBe(0);
  });

  it("ignores a mention that is not a list entry", () => {
    // Prose naming a journey is not a release — otherwise the document's own
    // explanation of the format would sign off J31.
    expect(isSignedOff("Write `- [J31 Title](…)` to release it.", "J31")).toBe(false);
  });

  it("does not let J3 release J35, or J35 release J3", () => {
    // `\b` rather than a prefix match. J3 and J35 are both real ids, and a
    // prefix would release four journeys nobody signed off.
    expect(isSignedOff("- J35 — released", "J3")).toBe(false);
    expect(isSignedOff("- J3 — released", "J35")).toBe(false);
  });

  it("reads platform ids too", () => {
    expect(isSignedOff("- P1 — released", "P1")).toBe(true);
  });
});

describe("journeyStatusLine", () => {
  const green = { failingPaths: [], totalPaths: 3 };

  it("releases a green, signed-off journey", () => {
    expect(journeyStatusLine({ ...green, signedOff: true })).toMatch(/^\*\*Dev Tested/);
  });

  it("holds a green journey nobody signed off", () => {
    expect(journeyStatusLine({ ...green, signedOff: false })).toMatch(/^\*\*In Dev Testing/);
  });

  it("refuses a red journey even when it is signed off", () => {
    // The sharp one: a sign-off must not push a failing journey past the gate.
    // `ready-for-qa.md` says so in prose; this is where it is true.
    const line = journeyStatusLine({
      failingPaths: ["happy"],
      totalPaths: 3,
      signedOff: true,
    });
    expect(line).toMatch(/^\*\*In Dev Testing/);
    expect(line).toContain("1 of 3");
    expect(line).toContain("`happy`");
  });
});

describe("withStatusLine", () => {
  it("replaces the line in place, leaving the rest of the page alone", () => {
    const page = ["# J35 Title", "", "**In Dev Testing — not ready.**", "", "## Why"].join("\n");
    const out = withStatusLine(page, "**Dev Tested — ready for QA.**");
    expect(out.split("\n")[2]).toBe("**Dev Tested — ready for QA.**");
    expect(out).toContain("## Why");
  });

  it("returns a page with no status line unchanged rather than inserting one", () => {
    // A file this does not recognise is a finding for the caller to report, not
    // something to repair by writing a line into whatever it actually is.
    const page = "# Something else\n\nnot a journey page\n";
    expect(withStatusLine(page, "**Dev Tested.**")).toBe(page);
  });
});

describe("a configured id prefix", () => {
  it("reads a multi-character prefix and ignores the default letters", () => {
    const md = ["- [JRN-12 Signing in](…) — released", "- J31 — released"].join("\n");
    expect([...signedOffIds(md, { prefixes: ["JRN-"] })]).toEqual(["JRN-12"]);
  });

  it("prefers the longest prefix, so JX7 is not read as J", () => {
    expect([...signedOffIds("- JX7 — released", { prefixes: ["J", "JX"] })]).toEqual(["JX7"]);
  });

  it("treats a prefix literally rather than as a pattern", () => {
    // `.` in a regex would match any character, releasing `JAB3` for `J.B`.
    expect(isSignedOff("- JAB3 — released", "JAB3", { prefixes: ["J.B"] })).toBe(false);
    expect(isSignedOff("- J.B3 — released", "J.B3", { prefixes: ["J.B"] })).toBe(true);
  });

  it("keeps the word boundary, so JRN-3 does not release JRN-35", () => {
    expect(isSignedOff("- JRN-35 — released", "JRN-3", { prefixes: ["JRN-"] })).toBe(false);
  });
});
