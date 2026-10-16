/**
 * What a `journey:masks` run says on its **last** line.
 *
 * **Its own module because the learning command starts a stack on import**,
 * so a test of the sentence cannot reach it — the same reason
 * `verdict.mts` is separate from the two scripts that write a verdict.
 *
 * ## Why the closing line had to change
 *
 * `journey:masks` runs Playwright three times and **only the third gates**.
 * That is deliberate and the argument for it is good: a failing journey still
 * produces screenshots, the recording stops where it broke, and every step
 * before that point is real and deserves a mask. So a red pass 1 warns and
 * carries on, and the run exits 0.
 *
 * What was wrong is that it then closed with *"Every recorded step is now
 * compared"* **whatever had happened**. The warning is 300-odd lines up by
 * then, and a reassuring last line beats a warning mid-scroll every time —
 * which is how J43's red pass 1 went unnoticed and was found days later by
 * grepping old logs (#923).
 *
 * That is this repository's own rule arriving one tool over: *prefer a check
 * that prints on success*. A summary identical whether or not something went
 * wrong cannot be told from one where nothing did.
 *
 * **The gate is untouched.** This changes what the run says, not what it
 * permits — trading a defensible design for a reporting problem would have
 * been the wrong repair.
 */
/**
 * The command that runs one journey once, named in the advice.
 *
 * door_nexa's spelling. Step 4 ships the learning CLI and the single-run command
 * beside it; until then a project whose runner is spelled differently passes its
 * own, and the sentence stays true for it.
 */
export const SINGLE_RUN = "pnpm test:journeys --journey <id> --persona <persona>";

export function closingLine(
  redLearningPasses: number[],
  { singleRun = SINGLE_RUN }: { singleRun?: string } = {},
): string {
  if (redLearningPasses.length === 0) {
    return "Every recorded step is now compared. Commit the masks with the recordings.";
  }

  const which =
    redLearningPasses.length === 1
      ? `pass ${redLearningPasses[0]} was red`
      : `passes ${redLearningPasses.join(" and ")} were red`;

  return (
    `Every recorded step is now compared, and ${which}.\n` +
    "Masks learned from a red pass are real — a recording stops where it broke\n" +
    "and everything before it is genuine — but the journey itself failed, and\n" +
    "this run does not say whether it still does.\n" +
    "\n" +
    "Fix the spec with a SINGLE run before learning again:\n" +
    "\n" +
    `    ${singleRun}\n` +
    "\n" +
    "Three passes to discover one broken locator is the expensive way round, and\n" +
    "it is the way everybody takes because this line used to say *re-run*."
  );
}
