/**
 * **The three passes, as a decision that can be tested without a browser.**
 *
 * `journeys learn` spawns a stack and runs Playwright three times, so it cannot
 * be unit-tested; what it *decides* lives here, with every effect a parameter.
 * The decision this exists for: **every abort before verification puts the
 * evidence back** (see `evidence-backup.mts`). A reset that fails before pass 2
 * or pass 3 used to return having left pass 1's references and masks in the
 * committed tree.
 */
import type { StackVerdict } from "../stack/probe.mts";
import type { EvidenceBackup, Undone } from "./evidence-backup.mts";

export type PassDeps = {
  /** Copy the evidence aside. Called once, before pass 1. */
  backup(): EvidenceBackup;
  /** Back to the seeded state; false when the host did not reset. */
  reset(): Promise<boolean>;
  /** Run one pass; its exit status. */
  play(label: string, learning: boolean): number;
  /** Did the stack survive the pass? */
  probe(): Promise<StackVerdict>;
  /** Register `undo` to run if the learner is interrupted; returns the unregister. */
  onInterrupt?(undo: () => Undone): () => void;
};

export type PassOutcome =
  | {
      kind: "aborted";
      /** Which pass the run stopped before (reset) or during (stack). */
      pass: 1 | 2 | 3;
      why: { kind: "reset" } | { kind: "stack"; verdict: Exclude<StackVerdict, "up"> };
      undone: Undone;
    }
  | {
      kind: "verified";
      /** Pass 3's exit status. */
      validated: number;
      redLearningPasses: number[];
      /**
       * Drop the copy and stop restoring on interrupt. Called by the learner
       * once pass 3 has run, so an interrupt during pass 3 still puts the
       * evidence back.
       */
      finish(): void;
    };

export async function runPasses(deps: PassDeps): Promise<PassOutcome> {
  const backup = deps.backup();
  const unregister = deps.onInterrupt?.(() => backup.restore()) ?? (() => {});
  const abort = (pass: 1 | 2 | 3, why: Extract<PassOutcome, { kind: "aborted" }>["why"]) => {
    unregister();
    return { kind: "aborted" as const, pass, why, undone: backup.restore() };
  };

  const redLearningPasses: number[] = [];
  for (const pass of [1, 2] as const) {
    if (!(await deps.reset())) return abort(pass, { kind: "reset" });
    const status = deps.play(
      `pass ${pass} of 3 — ${pass === 1 ? "matching against what is committed" : "learning what varies"}`,
      true,
    );
    // Asked before the exit code is read: the two answers are independent.
    const verdict = await deps.probe();
    if (verdict !== "up") return abort(pass, { kind: "stack", verdict });
    if (status !== 0) redLearningPasses.push(pass);
  }

  if (!(await deps.reset())) return abort(3, { kind: "reset" });
  const validated = deps.play("pass 3 of 3 — checking the mask actually holds", false);
  return {
    kind: "verified",
    validated,
    redLearningPasses,
    finish: () => {
      unregister();
      backup.discard();
    },
  };
}
