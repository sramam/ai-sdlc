import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * **Did the stack survive the pass that just learned from it?** (#550)
 *
 * `journey:masks` keeps learning after a red pass and says so — *"pass 1 was
 * red; masks are still learned"* — and that is **right for a partial
 * recording**: a journey that broke halfway still photographed real screens up
 * to the break, and those steps deserve masks. It is **wrong when the failure
 * is infrastructural**, and nothing told the two apart.
 *
 * ## What goes wrong, measured
 *
 * When journey-db becomes unreachable mid-run — `Can't reach database server at
 * 127.0.0.1:5443` — steps either side of the failure photograph a page that is
 * not working. The next pass diffs a broken screenshot against a good one, the
 * difference is most of the card, and **the mask is a union that only ever
 * grows**, so the box is permanent.
 *
 * J31, immediately after a pass in which the database dropped out:
 *
 * | step | mask |
 * | --- | ---: |
 * | `too-many-attempts/02` | **29.0%** |
 * | `too-many-codes/04` | 23.8% |
 * | `too-many-attempts/03`, `wrong-code/02`, `wrong-code/03` | 19.9% |
 *
 * The same journey relearned from a clean run: **worst 1.3%**, fourteen of
 * twenty-one steps hiding nothing. Nothing about the software changed between
 * those two numbers.
 *
 * ## Why the four guards already in place all miss it
 *
 * | guard | why it misses |
 * | --- | --- |
 * | a step that **throws** does not learn (the recorder) | per-step, and asks whether *this step's own assertion* failed. When the stack dies, earlier steps compared a good screenshot against a broken baseline without throwing themselves |
 * | `MASK_VERSION` discards boxes from an older rule | the rule did not change; only the run was bad |
 * | `MAX_STEP_COVERAGE` fails the census over its ceiling | it runs *after* the masks are written, so it reports the damage rather than preventing it — and it is a ratchet, so a bad run landing under it is absorbed silently |
 * | `snapToDom` drops an unattributable page-sized box | these are attributable and merely large — card-sized, not page-sized |
 *
 * ## The composition #550 asks for: detect it, abort, learn nothing
 *
 * **Detect** without touching the stack host (`host.mts`).
 * The control channel answers `404` to anything that is not `POST /reset`, so
 * *any* HTTP response at all proves the process is listening — and the control
 * server and the database live in the **same process**, so this is a direct
 * answer to *is the database still there*, not a proxy for it.
 *
 * **Learn nothing** by putting the mask files back. This is the load-bearing
 * half: aborting alone leaves pass 1's boxes on disk, and a union only grows,
 * so the next honest run inherits them for ever.
 *
 * **What is deliberately not restored: the screenshots.** They are megabytes of
 * PNG rather than small JSON, and they are not permanent the way a mask is — a
 * record pass replaces them wholesale, so a later clean run repairs them. git
 * already holds the good copies, so the refusal names the command instead of
 * this module snapshotting binaries.
 */

export type StackVerdict =
  /** An HTTP response came back, so the process is listening. */
  | "up"
  /** Nothing is listening: the stack died during the pass. */
  | "down"
  /**
   * **The third answer, named rather than folded into a neighbour.**
   *
   * A probe that times out is not evidence the database died — the process may
   * be alive and wedged, or the machine may simply be loaded, and a learning
   * pass is measured on machines where the load has read 219.
   *
   * It is nevertheless treated as *discard*, and that is a decision rather than
   * a default: **the cost of being wrong is asymmetric.** Throwing away a
   * learning pass is recoverable — re-run it, and it reproduces. A mask learned
   * over a broken stack is not: afterwards it is indistinguishable from a real
   * volatile region, which is `agents.md`'s own rule about which side yields
   * when two runs collide. So the retry budget below exists to make this answer
   * rare, and the refusal reports it as *could not establish* rather than as
   * *the stack died*, because those send somebody to different places.
   */
  | "unreadable";

/** One attempt's outcome, as the caller's transport saw it. */
export type Attempt = { status: number } | { error: unknown };

/**
 * Error codes that mean *nothing is listening on that port*.
 *
 * `ECONNREFUSED` is the ordinary death. `ECONNRESET` and `EPIPE` are a listener
 * that went away mid-exchange, which on a loopback control channel is the same
 * event caught a moment later. Anything else — including a timeout — is not a
 * claim about the process and falls through to `unreadable`.
 */
const GONE = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ERR_SOCKET_CLOSED"]);

/** The error `code`, wherever Node hid it — `fetch` wraps the real one in `cause`. */
const codeOf = (error: unknown): string | undefined => {
  for (const at of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const code = (at as { code?: unknown } | undefined)?.code;
    if (typeof code === "string") return code;
  }
  return undefined;
};

/**
 * **Any HTTP status is `up`, including 404** — which is what the control channel
 * returns for a liveness `GET`, since it serves only `POST /reset`.
 *
 * Reading 404 as *down* would be the whole check inverted: it would abort every
 * pass, every time, and the run would look as though the stack always dies.
 */
export function readAttempt(attempt: Attempt): StackVerdict {
  if ("status" in attempt) return "up";
  return GONE.has(codeOf(attempt.error) ?? "") ? "down" : "unreadable";
}

/**
 * Probe until something is conclusive, so a loaded machine does not cost a
 * learning pass.
 *
 * `up` and `down` are both conclusive and return immediately. Only `unreadable`
 * is retried, because it is the answer that might be the machine rather than
 * the stack — and it is the answer we would rather not act on.
 */
export async function probeStack(
  attempt: () => Promise<Attempt>,
  { attempts = 3, pauseMs = 1_000, sleep = defaultSleep } = {},
): Promise<StackVerdict> {
  let verdict: StackVerdict = "unreadable";
  for (let n = 0; n < attempts; n++) {
    verdict = readAttempt(await attempt());
    if (verdict !== "unreadable") return verdict;
    if (n < attempts - 1) await sleep(pauseMs);
  }
  return verdict;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * One liveness request against the control channel.
 *
 * `GET` rather than `POST /reset`, deliberately: a reset is destructive, and a
 * liveness check that wipes the database would be a probe with a side effect
 * bigger than the question.
 */
export const controlAttempt =
  (controlUrl: string, timeoutMs = 5_000) =>
  async (): Promise<Attempt> => {
    try {
      const answer = await fetch(controlUrl, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: answer.status };
    } catch (error) {
      return { error };
    }
  };

/** Every stored mask under a recordings tree, as repo-relative paths. */
export function maskFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const here = join(at, entry);
      if (statSync(here).isDirectory()) {
        walk(here);
        continue;
      }
      if (entry.endsWith(".png.mask.json")) out.push(here);
    }
  };
  walk(dir);
  return out.sort();
}

/** What every mask held before a pass ran. */
export function snapshotMasks(dir: string): Map<string, string> {
  return new Map(maskFiles(dir).map((f) => [f, readFileSync(f, "utf8")]));
}

/**
 * Put the masks back exactly as they were, and say what that undid.
 *
 * Three cases, and the third is the one a partial restore would miss: a mask
 * **created** by the bad pass has no snapshot entry, so it is removed rather
 * than left behind as a box list nobody learned deliberately.
 */
export function restoreMasks(
  dir: string,
  before: Map<string, string>,
): { reverted: string[]; removed: string[] } {
  const reverted: string[] = [];
  const removed: string[] = [];

  for (const file of maskFiles(dir)) {
    const was = before.get(file);
    if (was === undefined) {
      rmSync(file);
      removed.push(relative(dir, file));
      continue;
    }
    if (readFileSync(file, "utf8") === was) continue;
    writeFileSync(file, was);
    reverted.push(relative(dir, file));
  }

  /*
   * A mask the pass **deleted** is restored too. `--relearn` truncates rather
   * than unlinking, so this is not the common path — but a restore that could
   * only revert and remove would leave a hole and report success.
   */
  for (const [file, was] of before) {
    try {
      readFileSync(file);
    } catch {
      writeFileSync(file, was);
      reverted.push(relative(dir, file));
    }
  }

  return { reverted: reverted.sort(), removed: removed.sort() };
}

/** What to print when a learning pass ran over a stack that was not there. */
export function refusal(
  pass: number,
  verdict: Exclude<StackVerdict, "up">,
  undone: { reverted: string[]; removed: string[] },
  controlUrl: string,
  {
    evidenceRoot = "docs/journeys",
    stackName = "the stack host",
  }: { evidenceRoot?: string; stackName?: string } = {},
): string {
  const what =
    verdict === "down"
      ? `${stackName} is not listening on ${controlUrl} — the stack died during pass ${pass}.`
      : `${stackName} could not be reached on ${controlUrl} within the probe budget, so ` +
        `it cannot be established that the stack survived pass ${pass}.`;

  return [
    "",
    `  ${what}`,
    "",
    "  Steps either side of a mid-run stack failure photograph a page that is not",
    "  working, and a mask learned from that is a box over most of the card — which",
    "  a union carries for ever, afterwards indistinguishable from a real volatile",
    "  region. So nothing was learned (#550).",
    "",
    `  Masks put back:  ${undone.reverted.length} reverted, ${undone.removed.length} removed`,
    ...undone.reverted.map((f) => `    reverted  ${f}`),
    ...undone.removed.map((f) => `    removed   ${f}`),
    "",
    "  The screenshots this pass wrote are NOT restored — they are binaries git",
    "  already holds, and a record pass replaces them wholesale rather than unioning.",
    "  Discard them before relearning:",
    "",
    `    git restore ${evidenceRoot}`,
    "",
    "  Then start the pass again on a machine where the stack stays up.",
    "",
  ].join("\n");
}
