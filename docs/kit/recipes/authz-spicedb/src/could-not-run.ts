// "Could not run" is a third answer, never a pass (docs/kit/security.md).
// A matrix test whose engine is unreachable FAILS with COULD_NOT_RUN in its
// title; `test-ci.mts` turns a run whose only failures carry it into exit 2,
// which the project's ci step declares in `unknownExitCodes`.
// AUTHZ_ENGINE=skip is the one deliberate opt-out, and it says so loudly.

export const COULD_NOT_RUN = "AUTHZ-COULD-NOT-RUN";

export type EngineState = "reachable" | "unreachable" | "skipped";

export function engineState(reachable: boolean): EngineState {
  if (process.env.AUTHZ_ENGINE === "skip") return "skipped";
  return reachable ? "reachable" : "unreachable";
}

export function skipBanner(engine: string): string {
  const line = "!".repeat(72);
  return [
    line,
    `AUTHZ_ENGINE=skip: the ${engine} matrix is NOT being run.`,
    "No authorization cell below is verified. Never set this in CI.",
    line,
  ].join("\n");
}
