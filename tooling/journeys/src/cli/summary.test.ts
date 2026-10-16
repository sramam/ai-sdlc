import { describe, expect, it } from "vitest";

import { SINGLE_RUN, closingLine } from "./summary.mts";

/*
 * **A summary that cannot report a failure is one nobody can act on.**
 *
 * `journey:masks` gates only on its third pass, deliberately — a failing
 * journey still produces screenshots and its steps still deserve masks. The
 * defect was that it then closed with the same reassuring line whether or not
 * the first two passes were red, with the warning 300 lines above it.
 *
 * Tested rather than trusted because in door_nexa `scripts/` was linted by nothing and
 * type-checked by nothing (#917), so a template-literal slip here would only
 * show up at the end of a browser run somebody had waited ten minutes for.
 */

describe("the closing line of a journey:masks run", () => {
  it("is the quiet one when every pass was green", () => {
    expect(closingLine([])).toBe(
      "Every recorded step is now compared. Commit the masks with the recordings.",
    );
  });

  it("names a single red pass, in its last line", () => {
    const line = closingLine([1]);
    expect(line).toContain("pass 1 was red");
    /*
     * Singular, because "passes 1 were red" is the kind of slip that makes a
     * reader doubt the rest of the sentence.
     *
     * **Asserted against the plural *phrase*, not the word.** It read
     * `not.toContain("passes")` over the whole line, which is a correct check on
     * the wrong proposition — it failed the moment the line gained a sentence
     * that says "three passes" correctly, about something else. A test that
     * forbids a word anywhere forces the prose around it to be contorted, which
     * is how a message ends up worse than the one somebody meant to write.
     */
    expect(line).not.toContain("passes 1");
    expect(line).not.toContain("passes were red");
  });

  it("names both when both were red", () => {
    const line = closingLine([1, 2]);
    expect(line).toContain("passes 1 and 2 were red");
  });

  it("still says the masks are real, because they are", () => {
    // The gate is unchanged and this must not read as though the run failed:
    // the recording stops where it broke and everything before it is genuine.
    // A summary that overstated this would get the passes re-run for nothing.
    const line = closingLine([1]);
    expect(line).toContain("Every recorded step is now compared");
    expect(line).toContain("Masks learned from a red pass are real");
  });

  it("says what it does not know, rather than implying it passed", () => {
    // The third answer, named: the run cannot say whether the journey still
    // fails, because pass 3 compares against what pass 2 recorded.
    expect(closingLine([2])).toContain("does not say whether it still does");
  });

  it("differs between a clean run and a red one — the whole point", () => {
    expect(closingLine([])).not.toBe(closingLine([1]));
  });
});

describe("the single-run advice", () => {
  it("names door_nexa's command by default", () => {
    expect(closingLine([1])).toContain(SINGLE_RUN);
  });

  it("names the project's own command when it has one", () => {
    const line = closingLine([1], { singleRun: "pnpm e2e --grep J7" });
    expect(line).toContain("    pnpm e2e --grep J7\n");
    expect(line).not.toContain(SINGLE_RUN);
  });
});
