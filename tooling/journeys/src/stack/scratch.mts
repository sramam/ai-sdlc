/**
 * `test-results/` is scratch, and **only Playwright's own subdirectory was
 * ever cleared** (#1068). Everything beside it accumulated for the life of the
 * checkout — measured on `.claude/worktrees/recordings`, 2026-09-17:
 *
 * | | | swept by |
 * | --- | ---: | --- |
 * | `email-outbox` | **72M**, 11,833 files | nothing |
 * | `journey-baseline` | **125M** | only the journey being recorded, by itself |
 * | `mask-evidence` | **30M** | nothing |
 * | `playwright` | 48K | Playwright, every run — it is `outputDir` |
 *
 * 227M of scratch, of which 3M was managed.
 *
 * **Playwright's narrowing is why, and it was right.** `outputDir` used to be
 * `test-results/` itself, and Playwright clearing it at the start of every run
 * wiped the PGlite database the run was about to use — reported as
 * `58P01 could not open file`, which reads as corruption. Moving Playwright
 * into a subdirectory stopped that and incidentally left everything beside it
 * unowned.
 *
 * ## Keep-list, not a sweep-list
 *
 * The defect was a name nobody swept, so enumerating the names to sweep would
 * reproduce it on the next scratch directory somebody adds. Everything under
 * `test-results/` goes, **except** what another tool manages — which today is
 * one entry, Playwright's.
 *
 * The adapter's own data directory is deliberately *not* in the keep-list even
 * though an adapter may delete it itself. The overlap is free, and a
 * keep-list entry would make the stack's own *"fresh every run"* promise
 * depend on this file rather than on the line that states it.
 */

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Playwright's `outputDir`, which Playwright clears itself.
 *
 * Duplicated from the Playwright config rather than imported: door_nexa's
 * config called `freeJourneyPorts()` at module scope, which `SIGKILL`s whatever
 * holds the journey ports — so reading the name would kill the stack this
 * runs for. The recorder's config (step 3) must declare
 * `outputDir: "./<scratchRoot>/playwright"`, and a test will compare the two.
 */
export const MANAGED_BY_PLAYWRIGHT = "playwright";

/** What a sweep of `test-results/` would remove, given what is in it. */
export function scratchToSweep(
  entries: readonly string[],
  keep: readonly string[] = [MANAGED_BY_PLAYWRIGHT],
): string[] {
  return entries.filter((entry) => !keep.includes(entry)).sort();
}

/**
 * Clear the scratch this checkout's journey stack owns. Returns what went.
 *
 * `scratchRoot` is relative to `root` and defaults to `test-results`; `keep` is
 * the keep-list, and is a list rather than a flag because the next tool that
 * manages its own subdirectory belongs on it.
 *
 * **At the start of a run, never at the end**, and the captured mail is why:
 * `packages/email/agents.md` calls those messages *"steps of a journey rather
 * than side effects of one — nobody signs in without reading the code"*, so
 * clearing on teardown would make a finished run unwalkable by hand, which is
 * the thing the capture transport exists to prevent. It is also the rule
 * `agents.md` already states — **a sweep is for what a previous run
 * abandoned.**
 *
 * **A missing `test-results/` is not a failure**: a fresh checkout has none,
 * and the stack creates what it needs immediately after.
 */
export function sweepScratch(
  root: string,
  {
    scratchRoot = "test-results",
    keep = [MANAGED_BY_PLAYWRIGHT],
  }: { scratchRoot?: string; keep?: readonly string[] } = {},
): string[] {
  const dir = join(root, scratchRoot);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const going = scratchToSweep(entries, keep);
  for (const entry of going) rmSync(join(dir, entry), { recursive: true, force: true });
  return going;
}
