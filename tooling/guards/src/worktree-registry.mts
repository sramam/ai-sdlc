/**
 * Which agent session made which worktree: an append-only, machine-local log
 * (docs/kit/multi-agent.md § Provenance).
 *
 * Two halves, split by what merges: branch → session travels in commit
 * trailers (`provenance.mts`); worktree → session lives here, because
 * `.claude/worktrees/` is gitignored and so is this file.
 *
 * **Append-only JSONL**, never read-modify-write, so several agents creating
 * worktrees in the same second all succeed. `worktrees.mts --close` is the one
 * rewrite, explicit and rare.
 *
 * **The session id is the key**; a session can be renamed by hand.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseWorktreeAdd, worktreeListPorcelain } from "../../core/src/git-command.mts";

export type RegistryEvent = {
  /** ISO 8601, so the file sorts by time as text. */
  at: string;
  kind: "created" | "entered";
  /** The worktree's directory name under `.claude/worktrees/`. */
  worktree: string;
  /** `unknown` when the hook carried none: inventing an id would merge sessions. */
  sessionId: string;
  branch?: string;
  base?: string;
};

export const REGISTRY = ".claude/worktree-registry.jsonl";
export const UNKNOWN_SESSION = "unknown";

/**
 * `.claude/worktrees/<name>/…` → `<name>`; anything else → null. Stops at a
 * quote too: `"$MAIN/.claude/worktrees/x"` must yield `x`, not `x"`, or the
 * entry reads as permanent drift.
 */
export function worktreeNameFrom(path: string | undefined): string | null {
  if (!path) return null;
  const match = /\.claude\/worktrees\/([^/\s"']+)/.exec(path.replace(/\\/g, "/"));
  return match?.[1] ?? null;
}

export type HookInput = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: string; path?: string; name?: string; file_path?: string };
  tool_response?: unknown;
};

/** Did the tool call visibly fail? A refused `git worktree add` created nothing. */
function failed(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const r = response as { stdout?: unknown; stderr?: unknown; interrupted?: unknown };
  if (r.interrupted === true) return true;
  const text = `${typeof r.stdout === "string" ? r.stdout : ""}\n${typeof r.stderr === "string" ? r.stderr : ""}`;
  return /^fatal:/m.test(text);
}

/**
 * What this tool call should record, or null. Pure, so every branch is tested
 * without a filesystem. A `git worktree add` with no `-b` still records: a tree
 * with no branch of its own is exactly the kind nobody can attribute later.
 */
export function eventFor(input: HookInput, now = new Date()): RegistryEvent | null {
  const at = now.toISOString();
  const sessionId = input.session_id || UNKNOWN_SESSION;
  const args = input.tool_input ?? {};

  if (input.tool_name === "EnterWorktree") {
    const worktree = worktreeNameFrom(args.path) ?? (args.name || null);
    return worktree ? { at, kind: "entered", worktree, sessionId } : null;
  }

  if (input.tool_name !== "Bash") return null;
  const add = parseWorktreeAdd(args.command ?? "");
  if (!add || failed(input.tool_response)) return null;

  const worktree = worktreeNameFrom(add.path);
  if (!worktree) return null;
  const event: RegistryEvent = { at, kind: "created", worktree, sessionId };
  // A label it cannot read is a blank field, never a guess.
  if (!add.unreadable) {
    if (add.branch) event.branch = add.branch;
    if (add.base) event.base = add.base;
  }
  return event;
}

// ---- The file ---------------------------------------------------------------

export function readRegistry(root: string): RegistryEvent[] {
  const path = join(root, REGISTRY);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RegistryEvent];
      } catch {
        // A truncated line from an interrupted append. A log nobody can read
        // is worse than one missing its last entry.
        return [];
      }
    });
}

export function append(root: string, event: RegistryEvent): void {
  const path = join(root, REGISTRY);
  mkdirSync(dirname(path), { recursive: true });
  // One short line per call: atomic enough that writers need no coordination.
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function writeRegistry(root: string, events: RegistryEvent[]): void {
  const path = join(root, REGISTRY);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
}

/** Has any session claimed this worktree? What the trace's backfill asks first. */
export function isRecorded(events: RegistryEvent[], worktree: string): boolean {
  return events.some((e) => e.worktree === worktree);
}

// ---- Reading it back --------------------------------------------------------

export type WorktreeRecord = {
  worktree: string;
  /** Who made it — never who is in it now. `unknown` if only ever entered. */
  createdBy: string;
  branch?: string;
  base?: string;
  firstSeen: string;
  /** Sessions other than the creator that entered it, in order of first entry. */
  enteredBy: string[];
};

/** The log, folded into one row per worktree. */
export function summarise(events: RegistryEvent[]): WorktreeRecord[] {
  const rows = new Map<string, WorktreeRecord>();

  for (const event of events) {
    const row = rows.get(event.worktree) ?? {
      worktree: event.worktree,
      createdBy: UNKNOWN_SESSION,
      firstSeen: event.at,
      enteredBy: [],
    };
    if (event.kind === "created") {
      row.createdBy = event.sessionId;
      row.branch = event.branch;
      row.base = event.base;
      row.enteredBy = row.enteredBy.filter((s) => s !== event.sessionId);
    } else if (event.sessionId !== row.createdBy && !row.enteredBy.includes(event.sessionId)) {
      row.enteredBy.push(event.sessionId);
    }
    rows.set(event.worktree, row);
  }

  return [...rows.values()].sort((a, b) => a.worktree.localeCompare(b.worktree));
}

export type Drift = {
  /** On disk, never recorded. */
  unrecorded: string[];
  /** Recorded, gone from disk: removed without `--close`. */
  orphaned: WorktreeRecord[];
};

/**
 * The registry against `git worktree list`, in both directions. A one-way
 * check lets the log rot into fiction while still reading as complete.
 */
export function drift(records: WorktreeRecord[], live: string[]): Drift {
  const known = new Set(records.map((r) => r.worktree));
  return {
    unrecorded: live.filter((name) => !known.has(name)).sort(),
    orphaned: records.filter((r) => !live.includes(r.worktree)),
  };
}

/** Every event except this worktree's. */
export function pruneClosed(events: RegistryEvent[], worktree: string): RegistryEvent[] {
  return events.filter((e) => e.worktree !== worktree);
}

// ---- What git has -----------------------------------------------------------

export type LiveWorktree = { name: string; branch?: string };

/** Parse `git worktree list --porcelain`, keeping only `.claude/worktrees/*`. */
export function parsePorcelain(porcelain: string): LiveWorktree[] {
  const out: LiveWorktree[] = [];
  let current: LiveWorktree | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      const name = worktreeNameFrom(line.slice("worktree ".length));
      current = name ? { name } : null;
      if (current) out.push(current);
    } else if (line.startsWith("branch refs/heads/") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line.trim() === "") {
      current = null;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The worktrees git has for the repository at `root`, or null if git cannot say. */
export function liveWorktrees(root: string): LiveWorktree[] | null {
  const porcelain = worktreeListPorcelain(root);
  return porcelain === null ? null : parsePorcelain(porcelain);
}
