/**
 * **Which stack this run is recording against, said by the stack itself.**
 *
 * The stack host runs in its own process (Playwright's `webServer`, or the
 * learner's child), and the recorder runs in a test worker that never loaded
 * the adapter — so the host writes what the workers need to know into scratch,
 * once the app is ready:
 *
 * | | read by |
 * | --- | --- |
 * | `mode.name` | `run.json`'s `stack` — a timing whose stack is unknown supports no comparison (door_nexa #1484) |
 * | `mode.devOverlayPossible` | the recorder, deciding whether a hide rule matching nothing is a finding |
 * | `pid`, `startedAt` | the learner, telling *this* stack's readiness from a stale file |
 *
 * **In scratch, so the next stack's sweep removes it** before writing its own.
 * A stamp from a dead stack would otherwise read as ready.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STACK_STAMP = "stack.json";

export type StackStamp = {
  name: string;
  devOverlayPossible: boolean;
  /** The host process. */
  pid?: number;
  /** When the host was ready, epoch ms. */
  readyAt?: number;
};

/** Nothing written: no stack is known, and nothing about one is claimed. */
export const UNKNOWN_STACK: StackStamp = { name: "unknown", devOverlayPossible: false };

export function writeStackStamp(scratchDir: string, stamp: StackStamp): void {
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(join(scratchDir, STACK_STAMP), JSON.stringify(stamp, null, 2) + "\n");
}

export function readStackStamp(scratchDir: string): StackStamp {
  const file = join(scratchDir, STACK_STAMP);
  if (!existsSync(file)) return UNKNOWN_STACK;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StackStamp>;
    return typeof parsed.name === "string"
      ? { ...UNKNOWN_STACK, ...parsed, name: parsed.name }
      : UNKNOWN_STACK;
  } catch {
    return UNKNOWN_STACK;
  }
}
