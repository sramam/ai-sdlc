/**
 * PostToolUse: write the worktree registry, and claim an unrecorded worktree
 * for whoever is found working in it.
 *
 * **After, not before**: this records what was created, and a `git worktree
 * add` that git then refused created nothing.
 *
 * **It never fails a tool call.** A hook that can break a commit because a log
 * line would not write is a hook that gets deleted. Every path exits 0; a
 * registry that could not be written is a gap `pnpm worktrees` reports.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mainCheckout } from "../../core/src/git-command.mts";
import {
  UNKNOWN_SESSION,
  append,
  eventFor,
  isRecorded,
  readRegistry,
  worktreeNameFrom,
  type HookInput,
  type RegistryEvent,
} from "./worktree-registry.mts";

export const SESSION_FILE = ".agent-session";

/**
 * Drop the session id into the worktree, where `provenance.mts` reads it for
 * the `Session:` trailer — a git hook has no session context of its own.
 * Rewritten on entry too: the session committing is the one to name.
 */
export function stamp(root: string, worktree: string, sessionId: string): void {
  if (!sessionId || sessionId === UNKNOWN_SESSION) return;
  try {
    writeFileSync(join(root, ".claude", "worktrees", worktree, SESSION_FILE), `${sessionId}\n`);
  } catch {
    // The tree may not exist (yet). The trailer degrades to `Worktree:` alone.
  }
}

/**
 * A worktree nobody recorded — made in a plain shell, or by the harness for a
 * subagent with `isolation: "worktree"` — is claimed by the first session found
 * in it. As **`entered`, never `created`**: being found in a tree is not
 * evidence of having made it, so the report says `created by: unknown`, which
 * is exactly true. Self-limiting: once recorded, this does nothing.
 */
function backfill(root: string, worktree: string, sessionId: string, now: Date): void {
  if (isRecorded(readRegistry(root), worktree)) return;
  const claim: RegistryEvent = {
    at: now.toISOString(),
    kind: "entered",
    worktree,
    sessionId: sessionId || UNKNOWN_SESSION,
  };
  append(root, claim);
  stamp(root, worktree, claim.sessionId);
}

/**
 * `root` and `cwd` are parameters so a test never writes to the registry of the
 * tree the test runner happens to be standing in.
 */
export function run(
  stdin: string,
  root: string | null = null,
  cwd: string = process.cwd(),
  now = new Date(),
): void {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return; // not our shape
  }

  const here = input.cwd || cwd;
  const registryRoot = root ?? mainCheckout(here);
  if (!registryRoot) return; // could not ask: not a repository. Nothing to record.

  const event = eventFor(input, now);
  const current = worktreeNameFrom(here);

  try {
    // Claim the tree this session stands in, unless the event already is that claim.
    if (current && event?.worktree !== current) {
      backfill(registryRoot, current, input.session_id ?? "", now);
    }
    if (event) {
      append(registryRoot, event);
      stamp(registryRoot, event.worktree, event.sessionId);
    }
  } catch {
    // Deliberately swallowed: see the header.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    run(readFileSync(0, "utf8"));
  } catch {
    // Never the reason a tool call fails.
  }
  process.exit(0);
}
