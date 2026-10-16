/**
 * PreToolUse: a worktree forks from the integration branch (`origin/dev`).
 *
 * `worktree.baseRef` cannot encode this: it takes `fresh` (= `origin/main`) or
 * `head` (whatever the session is on), and neither names `dev`. A wrong base is
 * silent — the worktree looks fine until it merges — so the rule is enforced
 * where a worktree is created:
 *
 *     git worktree add …          refused unless the base is the integration branch
 *     EnterWorktree({ name })     refused: the tool cannot name a base
 *     EnterWorktree({ path })     allowed: the base was checked at creation
 *
 * The hook accepts `dev` and `origin/dev` alike — it checks the base is *named*
 * dev, not that it is current. Local `dev` lags every merge since somebody last
 * fast-forwarded it, so the messages say `origin/dev`.
 *
 * Not covered: a subagent with `isolation: "worktree"` (the harness creates it
 * without a tool call).
 *
 * Override with a comment, which survives into the transcript:
 *     git worktree add … main  # worktree-base: hotfix off production
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import { checkoutRoot, parseWorktreeAdd } from "../../core/src/git-command.mts";

const OVERRIDE = /#\s*worktree-base:\s*\S/;
export const DEFAULT_INTEGRATION = "dev";

export type HookInput = {
  tool_name?: string;
  cwd?: string;
  tool_input?: { command?: string; path?: string; name?: string };
};

export type Verdict = { decision: "allow" } | { decision: "deny"; reason: string };

const ALLOW: Verdict = { decision: "allow" };
const deny = (reason: string): Verdict => ({ decision: "deny", reason });

/** The spellings of the integration branch a base may take. */
export function acceptedBases(integration: string): Set<string> {
  return new Set([
    integration,
    `origin/${integration}`,
    `refs/heads/${integration}`,
    `refs/remotes/origin/${integration}`,
  ]);
}

export function verdict(input: HookInput, integration = DEFAULT_INTEGRATION): Verdict {
  const args = input.tool_input ?? {};
  const create = `  git worktree add .claude/worktrees/<name> -b <branch> origin/${integration}\n`;

  if (input.tool_name === "EnterWorktree") {
    if (args.path) return ALLOW;
    return deny(
      `A worktree forks from \`origin/${integration}\`, and \`EnterWorktree\` cannot say so: ` +
        "`worktree.baseRef` is only `fresh` (origin/main) or `head` (this session's " +
        "branch). Create it explicitly, then enter it by path:\n\n" +
        create +
        '  EnterWorktree({ path: ".claude/worktrees/<name>" })',
    );
  }

  if (input.tool_name !== "Bash") return ALLOW;
  const command = args.command ?? "";
  const add = parseWorktreeAdd(command);
  if (!add) return ALLOW;
  if (OVERRIDE.test(command)) return ALLOW;

  // Could not tell: the third answer, and it refuses. A wrong base is invisible
  // until merge; re-typing costs one command.
  if (add.unreadable || add.path === undefined) {
    return deny(
      "Could not read this `git worktree add` (a shell variable, or no path), so its " +
        `base cannot be confirmed as \`origin/${integration}\`. Write it plainly:\n\n` +
        create +
        "\n…or say why it is something else:  # worktree-base: <reason>",
    );
  }

  if (add.base === undefined) {
    return deny(
      "`git worktree add` with no base forks from HEAD — this session's branch, not " +
        `\`origin/${integration}\`. Name the base:\n\n` +
        create +
        "\n…or say why not:  # worktree-base: <reason>",
    );
  }

  if (!acceptedBases(integration).has(add.base)) {
    return deny(
      `This worktree would fork from \`${add.base}\`, not \`origin/${integration}\`. A worktree ` +
        `forks from the integration branch and merges back into it; one cut from elsewhere ` +
        "starts behind and its first act is catching up.\n\n" +
        create +
        `\n…or, if \`${add.base}\` is genuinely required:  # worktree-base: <reason>`,
    );
  }

  return ALLOW;
}

/**
 * The integration branch from `sdlc.config.ts`. Could not ask (no repository,
 * no config, a config that will not load) → the default, since a guard that
 * cannot start must not block every worktree.
 */
export async function integrationBranch(cwd: string): Promise<string> {
  try {
    const root = checkoutRoot(cwd) ?? findRoot(cwd);
    if (!root || !existsSync(join(root, "sdlc.config.ts"))) return DEFAULT_INTEGRATION;
    return (await loadConfig(root)).branches?.integration || DEFAULT_INTEGRATION;
  } catch {
    return DEFAULT_INTEGRATION;
  }
}

export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let input: HookInput = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
  } catch {
    process.exit(0); // not our shape: nothing to judge
  }
  // Only pay for the config when there is something to judge.
  const relevant =
    input.tool_name === "EnterWorktree" ||
    (input.tool_name === "Bash" && parseWorktreeAdd(input.tool_input?.command ?? "") !== null);
  if (relevant) {
    const result = verdict(input, await integrationBranch(input.cwd || process.cwd()));
    if (result.decision === "deny") console.log(denyOutput(result.reason));
  }
  process.exit(0);
}
