/**
 * PreToolUse: writes and commits do not land in the main checkout.
 *
 * The tree, index, HEAD and stash are shared, so a write there lands beside
 * whatever another session has in flight (docs/kit/multi-agent.md). The
 * question is the **checkout, not the branch** — a feature branch in the shared
 * tree is the case that went wrong — and git answers it: in the main checkout
 * `--git-dir` equals `--git-common-dir`.
 *
 *     Edit · Write · NotebookEdit · MultiEdit   refused when the target is in the main checkout
 *     git commit                                refused when git would run there
 *
 * **The honest gap:** a Bash command that writes a file (`sed -i`, a heredoc)
 * is not gated; parsing shell to find its target is guessing. `git commit` is
 * the backstop — bytes cannot reach history without passing it.
 *
 * **Escapes**, both keyed so they cannot go stale:
 *     .claude/worktree-exempt     `<session id>  <reason>` — exempts that session only
 *     # worktree: <reason>        on one command line
 * `docs/handoffs/` is exempt by path: a handoff written in a worktree dies with it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../core/src/config.mts";
import { canonical, gitSegment, gitWorkingDir, mainCheckout } from "../../core/src/git-command.mts";
import { DEFAULT_INTEGRATION, denyOutput } from "./worktree-base.mts";

const NAMED_WRITE = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const OVERRIDE = /#\s*worktree:\s*(\S.*)$/m;

export const EXEMPT_FILE = ".claude/worktree-exempt";
export const DEFAULT_EXEMPT_PATHS = ["docs/handoffs/"];

/** The variable holding this session's id; equals the hook input's `session_id`. */
export const SESSION_VAR = "CLAUDE_CODE_SESSION_ID";

export type HookInput = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: string; file_path?: string; notebook_path?: string };
};

export type Verdict = { decision: "allow"; note?: string } | { decision: "deny"; reason: string };

export type Facts = {
  /** The main checkout: the directory holding the common `.git`. */
  mainCheckout: string;
  /** The claim in `.claude/worktree-exempt`, if any. */
  exemption: { sessionId: string; reason: string } | null;
  /** Repo-relative prefixes written from anywhere and correct only here. */
  exemptPaths?: string[];
  integration?: string;
  /** Resolves `-C`/relative paths; the entry point passes a symlink-aware one. */
  resolvePath?: (...parts: string[]) => string;
};

const ALLOW: Verdict = { decision: "allow" };
const deny = (reason: string): Verdict => ({ decision: "deny", reason });

/** Is `child` at or below `parent`? By segment, so `/a/bc` is not under `/a/b`. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

/**
 * A fallback worktree name, derived from the session id: stable across repeated
 * refusals in one session, distinct between sessions starting at once.
 */
export function autoName(sessionId: string): string {
  return `wt-${createHash("sha1")
    .update(sessionId || "unknown")
    .digest("hex")
    .slice(0, 6)}`;
}

function refusal(what: string, sessionId: string, integration: string): string {
  const auto = autoName(sessionId);
  return (
    `${what} in the **main checkout**. Work happens in a worktree forked from ` +
    `\`origin/${integration}\` — the main tree is shared, so a write here lands beside ` +
    "whatever another session has in flight.\n\n" +
    "**Ask the user what to call the worktree before creating it** — propose a name " +
    `from the work in hand, and offer \`${auto}\` for when they would rather not choose:\n\n` +
    `  git worktree add .claude/worktrees/${auto} -b <branch> origin/${integration}\n` +
    `  EnterWorktree({ path: ".claude/worktrees/${auto}" })\n\n` +
    "If this session genuinely belongs in the main checkout, say why — for this session only:\n\n" +
    `  echo "$${SESSION_VAR}  <reason>" > ${EXEMPT_FILE}\n\n` +
    "…or on one command:   git commit -m '…'  # worktree: <reason>"
  );
}

export function verdict(input: HookInput, facts: Facts): Verdict {
  const tool = input.tool_name ?? "";
  const args = input.tool_input ?? {};
  const session = input.session_id ?? "";
  const integration = facts.integration ?? DEFAULT_INTEGRATION;
  const resolvePath = facts.resolvePath ?? resolve;

  const named = NAMED_WRITE.has(tool);
  const commit = tool === "Bash" ? gitSegment(args.command ?? "", "commit") : null;
  if (!named && !commit) return ALLOW;

  const cwd = input.cwd || process.cwd();
  const stated = commit ? OVERRIDE.exec(args.command ?? "") : null;

  // For a named write, the file itself — which is what lets a worktree session
  // write a handoff into the main checkout. For a commit, where git would run.
  let target: string;
  if (named) {
    const file = args.file_path ?? args.notebook_path;
    if (!file) return ALLOW; // nothing named: not ours to judge
    target = resolvePath(cwd, file);
  } else {
    const dir = gitWorkingDir(commit!, cwd, resolvePath);
    if (dir === null) {
      // Could not tell: refused. Guessing "here" on a commit is how the shared
      // tree gets written to; the other way costs one comment.
      if (stated) return { decision: "allow", note: `stated reason: ${stated[1]!.trim()}` };
      return deny(
        "Could not tell which checkout this `git commit` would land in — its `-C` or " +
          "`--work-tree` is a shell variable. Write the path plainly, run it from the " +
          "directory it belongs to, or say why:\n\n  git commit -m '…'   # worktree: <reason>",
      );
    }
    target = dir;
  }

  if (!within(facts.mainCheckout, target)) return ALLOW; // outside the repository
  if (within(join(facts.mainCheckout, ".claude", "worktrees"), target)) return ALLOW;

  const rel = relative(facts.mainCheckout, target).split(sep).join("/");
  const exemptPaths = facts.exemptPaths ?? DEFAULT_EXEMPT_PATHS;
  if (named && exemptPaths.some((prefix) => rel.startsWith(prefix))) return ALLOW;

  if (stated) return { decision: "allow", note: `stated reason: ${stated[1]!.trim()}` };

  const what = named ? "This edit would land" : "This commit would be made";
  const claim = facts.exemption;
  if (claim) {
    // Checked before the equality: an empty id is a claim that lost its key
    // (the variable was unset), and `"" === ""` would open the gate to anybody.
    if (claim.sessionId === "") {
      return deny(
        `${refusal(what, session, integration)}\n\n` +
          `Note: \`${EXEMPT_FILE}\` holds a reason — "${claim.reason}" — with **no session id**, ` +
          `so it exempts nobody. \`${SESSION_VAR}\` was unset when it was written. Again, with the id:\n\n` +
          `  echo "$${SESSION_VAR}  ${claim.reason}" > ${EXEMPT_FILE}`,
      );
    }
    if (session !== "" && claim.sessionId === session) {
      return { decision: "allow", note: `exempt: ${claim.reason}` };
    }
    // Somebody else's claim, left behind: neither "exempt" nor "none".
    return deny(
      `${refusal(what, session, integration)}\n\n` +
        `Note: \`${EXEMPT_FILE}\` claims an exemption for a different session ` +
        `(${claim.sessionId}) — "${claim.reason}". It does not cover this one; if that ` +
        "session is finished, the file should be deleted rather than reused.",
    );
  }

  return deny(refusal(what, session, integration));
}

// ---- The facts, read from the world -----------------------------------------

/**
 * `<sessionId>  <reason>`. Not trimmed before matching: `echo "$UNSET  why"`
 * writes a line whose first character is a space, and trimming would read the
 * first word of the reason as a session id. Leading whitespace = empty id.
 */
export function readExemption(root: string): Facts["exemption"] {
  const path = join(root, EXEMPT_FILE);
  if (!existsSync(path)) return null;
  try {
    const line = (readFileSync(path, "utf8").split("\n")[0] ?? "").replace(/\r$/, "");
    if (line.trim() === "") return null;
    if (/^\s/.test(line)) return { sessionId: "", reason: line.trim() };
    const match = /^(\S+)\s+(\S.*)$/.exec(line);
    return match ? { sessionId: match[1]!, reason: match[2]!.trim() } : null;
  } catch {
    return null;
  }
}

async function configFacts(root: string): Promise<Pick<Facts, "exemptPaths" | "integration">> {
  try {
    if (!existsSync(join(root, "sdlc.config.ts"))) return {};
    const config = await loadConfig(root);
    const handoffs = config.dirs?.handoffs?.replace(/\/*$/, "/");
    return {
      integration: config.branches?.integration || undefined,
      exemptPaths: handoffs ? [handoffs] : undefined,
    };
  } catch {
    return {}; // the defaults
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let input: HookInput = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
  } catch {
    process.exit(0);
  }
  const tool = input.tool_name ?? "";
  const relevant =
    NAMED_WRITE.has(tool) ||
    (tool === "Bash" && gitSegment(input.tool_input?.command ?? "", "commit") !== null);

  // Could not ask (not a repository, no git) → allow, chosen: being wrong costs
  // one write in a shared tree; the other way is a session that cannot edit at all.
  const root = relevant ? mainCheckout(input.cwd || process.cwd()) : null;
  if (root) {
    const cwd = canonical(input.cwd || process.cwd());
    const result = verdict(
      { ...input, cwd },
      {
        mainCheckout: root,
        exemption: readExemption(root),
        resolvePath: (...parts) => canonical(resolve(...parts)),
        ...(await configFacts(root)),
      },
    );
    if (result.decision === "deny") console.log(denyOutput(result.reason));
    // Prints on success: a gate whose normal output is silence cannot be told
    // from one that never ran.
    else if (result.note)
      console.error(`worktree-required: allowed in the main checkout — ${result.note}`);
  }
  process.exit(0);
}
