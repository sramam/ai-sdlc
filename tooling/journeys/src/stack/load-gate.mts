/**
 * The precondition for a learning pass, **in the command** (#1021).
 *
 * door_nexa's `agents.md` stated the rule and the form it must take:
 *
 * > ```
 * > 1-minute load under 12          nobody is compiling
 * > no other checkout recording     nobody is running   (one pgrep)
 * > as a precondition in the command, not a check you then act on
 * > ```
 *
 * **Nothing implemented it.** `os.loadavg()` appeared nowhere in door_nexa's
 * `scripts/` or `e2e/`, so every pass ever started was somebody reading `uptime`,
 * deciding, and then starting — which is the third line describing what must
 * *not* happen.
 *
 * ## Why the gap between the reading and the start is the whole point
 *
 * A learning pass is not steady: it compiles a route, walks a step, then sits
 * through `2 × JOURNEY_DWELL` watching for motion. So **the quietest moment
 * of a learning pass is indistinguishable from an idle machine**, and it is
 * the worst moment to start, because the reading is lowest exactly when the
 * next step lands. Measured 2026-09-16 while five journeys were held: the
 * 1-minute load read **33.92 → 88.15 → 68.31 → 43.81** across twenty minutes.
 *
 * A check followed by an action is a race, and the dwell trough is how wide
 * that race can be. A gate inside the command closes it; a human reading
 * `uptime` cannot.
 *
 * ## What it costs to be wrong
 *
 * A contended pass photographs a page mid-flight, and **a red pass 1 still
 * writes masks** — permanently, because the union only grows and the artefact
 * is afterwards indistinguishable from a legitimately volatile region (#715).
 * The failure is not a slow run; it is a committed, wrong mask.
 *
 * ## Only `journey:masks`
 *
 * `test:journeys` compares and writes no mask, so a contended run there costs
 * time rather than correctness. Gating it would refuse work for no benefit.
 *
 * This is also **not a concurrency rule**: `agents.md` rejects one because it
 * *"cannot reach another machine, and does nothing for the single-lane
 * case"*. This is a precondition on one command in one checkout.
 */

import { execFileSync } from "node:child_process";
import { cpus, loadavg } from "node:os";

/**
 * Processes that mean somebody is recording, rather than merely busy.
 *
 * This package's own CLIs: `cli/learn.mts` is the learning command and
 * `cli/stack.mts` is the stack host it (or Playwright's `webServer`) fathers —
 * either one alive in another checkout is a pass in flight. door_nexa's were
 * `journey-masks` and `journey-db`; the `journeys` bin spawns each
 * subcommand as its own `node …/cli/<name>.mts` process precisely so these
 * substrings appear on a command line. Matched with `pgrep -f`.
 * `recordingProcessNames` in `journeys.config.mts` replaces the list; a name
 * short enough to match unrelated commands refuses runs for nothing, so name
 * the scripts rather than the interpreter.
 */
export const DEFAULT_RECORDING_PROCESSES: readonly string[] = [
  "journeys/src/cli/learn.mts",
  "journeys/src/cli/stack.mts",
];

/**
 * **Derived from the machine, and it reproduces the documented 12.**
 *
 * `agents.md` says *1-minute load under 12*, written on a 10-core laptop.
 * Hard-coding it would be a number that means something different on every
 * other machine — the decay this repository opens by warning about — so it
 * is `cores + 2`, which is 12 here and stays proportionate elsewhere.
 */
export const loadCeiling = (cores: number): number => cores + 2;

export type Verdict =
  { kind: "go" } | { kind: "stop"; why: string } | { kind: "cannot-ask"; why: string };

/**
 * **`cannot-ask` allows, and that is chosen rather than defaulted.**
 *
 * A platform without `loadavg` — Windows reports zeroes — must not make
 * recording impossible. Being wrong that way costs one contended run; being
 * wrong the other way is a suite nobody can run at all. It still *says* so,
 * because a precondition whose normal output is silence cannot be told from
 * one that never ran.
 */
export function verdict(
  load: number,
  cores: number,
  others: readonly string[],
  override: string | null,
): Verdict {
  if (override) return { kind: "go" };

  if (others.length > 0) {
    return {
      kind: "stop",
      why:
        `another checkout is recording: ${others.join(", ")}. Two learning passes ` +
        `can photograph each other's steps mid-flight, and a wrong mask is permanent`,
    };
  }

  // Zero is what a platform with no load average reports, and it is also what
  // a genuinely idle machine reports. Treated as unreadable rather than as
  // idle: claiming a quiet machine is the flattering direction, and this
  // whole gate exists because the flattering reading is the dangerous one.
  if (!Number.isFinite(load) || load <= 0) {
    return { kind: "cannot-ask", why: "this platform reports no load average" };
  }

  const ceiling = loadCeiling(cores);
  if (load > ceiling) {
    return {
      kind: "stop",
      why:
        `1-minute load is ${load.toFixed(1)}, over ${ceiling} on ${cores} cores. ` +
        `A pass started into this photographs pages mid-flight, and pass 1 writes ` +
        `masks even when it is red`,
    };
  }
  return { kind: "go" };
}

/** Other checkouts with a recording process alive, by checkout path. */
export function otherCheckoutsRecording(
  ours: string | null,
  owner: (pid: number) => string | null,
  probe: (name: string) => number[] = pidsOf,
  names: readonly string[] = DEFAULT_RECORDING_PROCESSES,
): string[] {
  const found = new Set<string>();
  for (const name of names) {
    for (const pid of probe(name)) {
      const checkout = owner(pid);
      // An unattributable process is **not** counted. `agents.md`'s port sweep
      // treats unknown as unsafe-to-kill, which is right for killing; here the
      // consequence is refusing somebody's run, and refusing on a process
      // nobody can place is how a gate gets routed around.
      if (checkout && checkout !== ours) found.add(checkout);
    }
  }
  return [...found].sort();
}

function pidsOf(name: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch {
    return [];
  }
}

/**
 * The reason somebody gave for going anyway, or null.
 *
 * An **env var rather than a trailing `# journey-load:` comment**, which is
 * the form `worktree-base` and `worktree-single` use — a shell strips a
 * comment before `exec`, so a script can never see one. The reason is printed
 * into the run's own output instead, which is where it needs to survive.
 */
export const overrideReason = (): string | null =>
  process.env.JOURNEY_LOAD_OVERRIDE?.trim() || null;

/** The whole precondition, read from this machine. */
export function check(
  ours: string | null,
  owner: (pid: number) => string | null,
  names: readonly string[] = DEFAULT_RECORDING_PROCESSES,
): Verdict {
  return verdict(
    loadavg()[0] ?? 0,
    cpus().length,
    otherCheckoutsRecording(ours, owner, pidsOf, names),
    overrideReason(),
  );
}
