/**
 * PreToolUse: one **live** worktree per session.
 *
 * A second tree in one session gives two branches the same `Session:` trailer,
 * so `git log` still cannot say which line of work changed what. And the
 * harness, on switching, leaves the first tree untracked for cleanup and no
 * longer writable by the session that made it.
 *
 * **Live, not ever.** A session that finished, removed and closed a tree is
 * entitled to its next one, so the set is reconciled against disk:
 *
 *     this session's created/entered records   ∩   git worktree list
 *
 * | this session has none | allow — including entering another agent's tree (`/pickup`) |
 * | the target is already this session's | allow — re-entering is not switching |
 * | a different tree | deny, naming the one open and how to close it |
 *
 * It is only as good as the registry: a session whose events were never
 * written looks like one with no worktrees, and this allows.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mainCheckout, parseWorktreeAdd } from "../../core/src/git-command.mts";
import { denyOutput } from "./worktree-base.mts";
import { liveWorktrees, readRegistry, worktreeNameFrom } from "./worktree-registry.mts";

const OVERRIDE = /#\s*worktree-single:\s*(\S.*)$/m;

export type HookInput = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: string; path?: string; name?: string };
};

export type Verdict = { decision: "allow"; note?: string } | { decision: "deny"; reason: string };

export type Facts = {
  /** This session's worktrees that git still has, by name. */
  open: string[];
};

const ALLOW: Verdict = { decision: "allow" };

/** The worktree this call would open, or null when it opens none. */
export function targetOf(input: HookInput): string | null {
  const args = input.tool_input ?? {};
  if (input.tool_name === "EnterWorktree") {
    return args.path ? worktreeNameFrom(args.path) : args.name || null;
  }
  if (input.tool_name !== "Bash") return null;
  const add = parseWorktreeAdd(args.command ?? "");
  return add ? worktreeNameFrom(add.path) : null;
}

export function verdict(input: HookInput, facts: Facts): Verdict {
  const target = targetOf(input);
  if (!target) return ALLOW;
  if (facts.open.length === 0) return ALLOW;
  if (facts.open.includes(target)) return ALLOW;

  // `EnterWorktree` has no command line, so no override: closing the first
  // tree is the honest way through, and it is always available.
  const stated = OVERRIDE.exec(input.tool_input?.command ?? "");
  if (stated) return { decision: "allow", note: `stated reason: ${stated[1]!.trim()}` };

  const first = facts.open[0]!;
  return {
    decision: "deny",
    reason:
      "This session already has a worktree open:\n\n" +
      facts.open.map((name) => `  .claude/worktrees/${name}`).join("\n") +
      `\n\nOpening \`${target}\` beside it gives both branches' commits the same ` +
      "`Session:` trailer, and the harness leaves the first tree untracked and no " +
      "longer writable by this session.\n\n**Finish the open one, then close it:**\n\n" +
      `  git worktree remove .claude/worktrees/${first}\n` +
      `  pnpm worktrees --close ${first}\n\n` +
      "If two really are needed at once, say why on the command:  # worktree-single: <reason>",
  };
}

/**
 * This session's worktrees, reconciled against disk. Created **and** entered:
 * a tree picked up from somebody else is just as much the one in use.
 */
export function openWorktrees(root: string, sessionId: string, live: string[]): string[] {
  if (!sessionId) return [];
  const mine = new Set(
    readRegistry(root)
      .filter((e) => e.sessionId === sessionId)
      .map((e) => e.worktree),
  );
  return live.filter((name) => mine.has(name));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let result: Verdict = ALLOW;
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    if (targetOf(input)) {
      const root = mainCheckout(input.cwd || process.cwd());
      const live = root ? liveWorktrees(root) : null;
      // Could not ask (no repository, git failed) → allow, chosen: a wrong allow
      // is one extra tree `pnpm worktrees` reports; a wrong deny is a session
      // that cannot open its first tree right after being refused the main one.
      if (root && live) {
        const open = openWorktrees(
          root,
          input.session_id ?? "",
          live.map((w) => w.name),
        );
        result = verdict(input, { open });
      }
    }
  } catch {
    result = ALLOW;
  }
  if (result.decision === "deny") console.log(denyOutput(result.reason));
  else if (result.note)
    console.error(`worktree-single: allowed a second worktree — ${result.note}`);
  process.exit(0);
}
