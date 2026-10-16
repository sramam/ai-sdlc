import { describe, expect, it } from "vitest";
import { CODEBURN, usageArgs } from "./usage.mts";

const MAIN = "/repo";

describe("usageArgs", () => {
  it("defaults to the report, scoped to the main checkout", () => {
    expect(usageArgs([], MAIN)).toEqual({
      ok: true,
      args: ["dlx", CODEBURN, "report", "--project", MAIN],
    });
  });

  it("passes a command and its flags through, adding the scope", () => {
    expect(usageArgs(["spend", "--format", "branch-json", "--period", "30days"], MAIN)).toEqual({
      ok: true,
      args: [
        "dlx",
        CODEBURN,
        "spend",
        "--format",
        "branch-json",
        "--period",
        "30days",
        "--project",
        MAIN,
      ],
    });
  });

  it("keeps a scope the caller chose", () => {
    for (const scope of [
      ["--project", "/elsewhere"],
      ["--project=/elsewhere"],
      ["--exact-project"],
    ]) {
      const plan = usageArgs(["report", ...scope], MAIN);
      expect(plan.ok && plan.args.filter((a) => a === MAIN)).toEqual([]);
    }
  });

  it("refuses the commands that send usage off the machine", () => {
    for (const cmd of ["sync", "share", "devices"]) {
      const plan = usageArgs([cmd, "push"], MAIN);
      expect(plan.ok).toBe(false);
    }
  });

  it("pins an exact version", () => {
    expect(CODEBURN).toMatch(/^codeburn@\d+\.\d+\.\d+$/);
  });
});
