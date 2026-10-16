/**
 * `pnpm claim <ID> [--session <id>]` — claim a work item, atomically.
 *
 * A claim is a remote branch named exactly the lower-cased item ID (`f03-012`,
 * no slug), so two agents claiming one item are asking for the same ref and
 * only one can have it. The branch is made through the GitHub API, in two
 * steps, neither of which touches the local checkout:
 *
 *   1. a commit on top of origin/<integration>, with that tip's tree (so it
 *      changes nothing) and the message
 *
 *        Claim: F03-012
 *
 *        Claimed-By: <--session, else git config user.email>
 *        Claimed-At: <ISO 8601 time>
 *
 *   2. `refs/heads/f03-012` pointing at it. GitHub creates a ref only if it
 *      does not exist, so this is the atomic step: a 422 "Reference already
 *      exists" means somebody else holds the item.
 *
 * `plan:status` reads the claim time from that commit's `Claimed-At:`, not from
 * the branch tip's date. The commit made in step 1 by a claimant who then loses
 * step 2 is referenced by nothing and is collected by GitHub.
 *
 * It prints the commands to fetch the branch and make the worktree, and runs
 * neither: the worktree is the session's to create (worktree-base, worktree-
 * single), and this tool only ever talks to the remote.
 *
 * Exit: 0 claimed; 3 somebody else holds it (and who); 2 bad usage, an unknown
 * or dropped item, or no identity to claim as; 1 could not ask (gh missing,
 * not signed in, the API refused something other than an existing ref).
 */
import { findRoot, loadConfig } from "../../core/src/config.mts";
import { exec as realExec, firstLine, isEntry } from "../../core/src/exec.mts";
import type { Exec, ExecResult } from "../../core/src/exec.mts";
import { DEFAULT_DIRS, loadItems, normId } from "./plan-lib.mts";
import type { Dirs, Item } from "./plan-lib.mts";

export const CLAIM_ID = /^(?:F\d+-\d+|X-\d+)$/;

/** The claim commit's message: the subject `plan:status` walks to, and two trailers. */
export function claimMessage(id: string, by: string, at: Date): string {
  return `Claim: ${id}\n\nClaimed-By: ${by}\nClaimed-At: ${at.toISOString()}`;
}

/** The canonical claim branch for an item: its ID, lower case. */
export function claimBranch(id: string): string {
  return id.toLowerCase();
}

export interface ClaimDeps {
  root: string;
  integration: string;
  items: Item[];
  exec: Exec;
  now: () => Date;
  log: (line: string) => void;
}

const API = "repos/{owner}/{repo}";

function gh(deps: ClaimDeps, args: string[]): Promise<ExecResult> {
  return deps.exec("gh", ["api", ...args], { cwd: deps.root, timeoutMs: 30_000 });
}

function why(r: ExecResult): string {
  if (r.notFound) return "gh is not installed";
  if (r.timedOut) return "gh timed out";
  return firstLine(r.stderr || r.stdout, 200) || `exit ${r.code}`;
}

/** Who holds a claim branch, read from its `Claim:` commit. */
export async function holder(deps: ClaimDeps, id: string): Promise<string> {
  const branch = claimBranch(id);
  const r = await gh(deps, [`${API}/commits?sha=${branch}&per_page=100`]);
  if (r.code !== 0) return `branch ${branch} exists (could not read who holds it: ${why(r)})`;
  let commits: Array<{ sha?: string; commit?: { message?: string } }>;
  try {
    commits = JSON.parse(r.stdout) as typeof commits;
  } catch {
    return `branch ${branch} exists (could not read who holds it: unreadable reply)`;
  }
  for (const c of commits) {
    const msg = c.commit?.message ?? "";
    if ((msg.split("\n")[0] ?? "").trim().toLowerCase() !== `claim: ${id.toLowerCase()}`) continue;
    const by = /^Claimed-By:\s*(.+)$/im.exec(msg)?.[1]?.trim() ?? "(no Claimed-By)";
    const at = /^Claimed-At:\s*(.+)$/im.exec(msg)?.[1]?.trim() ?? "(no Claimed-At)";
    return `${by}, since ${at} (claim commit ${(c.sha ?? "").slice(0, 10)})`;
  }
  return `branch ${branch} exists with no "Claim: ${id}" commit — it was made outside pnpm claim`;
}

export async function claim(
  rawId: string,
  opts: { session?: string },
  deps: ClaimDeps,
): Promise<number> {
  const id = normId(rawId);
  if (!CLAIM_ID.test(id)) {
    deps.log(`claim: ${rawId} is not an item ID (F<nn>-<nnn> or X-<nnn>)`);
    return 2;
  }
  const item = deps.items.find((i) => i.id === id);
  if (!item) {
    deps.log(`claim: no item ${id} in docs/plan/items`);
    return 2;
  }
  if (item.dropped) {
    deps.log(`claim: ${id} is dropped (${item.dropped}); there is nothing to claim`);
    return 2;
  }
  let by = opts.session?.trim();
  if (!by) {
    const email = await deps.exec("git", ["config", "user.email"], { cwd: deps.root });
    by = email.code === 0 ? email.stdout.trim() : "";
  }
  if (!by) {
    deps.log("claim: who is claiming? Pass --session <id>, or set git config user.email");
    return 2;
  }
  const branch = claimBranch(id);

  const tipR = await gh(deps, [`${API}/git/ref/heads/${deps.integration}`, "--jq", ".object.sha"]);
  const tip = tipR.stdout.trim();
  if (tipR.code !== 0 || !/^[0-9a-f]{40}$/.test(tip)) {
    deps.log(`claim: COULD NOT ASK where origin/${deps.integration} is: ${why(tipR)}`);
    return 1;
  }
  const treeR = await gh(deps, [`${API}/git/commits/${tip}`, "--jq", ".tree.sha"]);
  const tree = treeR.stdout.trim();
  if (treeR.code !== 0 || !/^[0-9a-f]{40}$/.test(tree)) {
    deps.log(`claim: COULD NOT ASK for the tree of ${tip.slice(0, 10)}: ${why(treeR)}`);
    return 1;
  }
  const at = deps.now();
  const commitR = await gh(deps, [
    `${API}/git/commits`,
    "-f",
    `message=${claimMessage(id, by, at)}`,
    "-f",
    `tree=${tree}`,
    "-f",
    `parents[]=${tip}`,
    "--jq",
    ".sha",
  ]);
  const sha = commitR.stdout.trim();
  if (commitR.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    deps.log(`claim: COULD NOT ASK GitHub to make the claim commit: ${why(commitR)}`);
    return 1;
  }
  const refR = await gh(deps, [
    `${API}/git/refs`,
    "-f",
    `ref=refs/heads/${branch}`,
    "-f",
    `sha=${sha}`,
  ]);
  if (refR.code !== 0) {
    const text = `${refR.stderr}\n${refR.stdout}`;
    if (/reference already exists/i.test(text) || /HTTP 422/.test(text)) {
      deps.log(`claim: ${id} is already claimed: ${await holder(deps, id)}`);
      return 3;
    }
    deps.log(`claim: COULD NOT ASK GitHub to create ${branch}: ${why(refR)}`);
    return 1;
  }
  deps.log(
    `claim: ${id} claimed as origin/${branch} by ${by} at ${at.toISOString()} (claim commit ${sha.slice(0, 10)} on origin/${deps.integration} ${tip.slice(0, 10)})`,
  );
  deps.log("Next, from the main checkout (not run for you):");
  deps.log(`  git fetch origin ${branch}`);
  deps.log(
    `  git worktree add .claude/worktrees/${branch} -b ${branch} origin/${branch}  # worktree-base: claim branch for ${id}, cut from origin/${deps.integration}`,
  );
  return 0;
}

export async function main(argv: string[], exec: Exec = realExec): Promise<number> {
  const si = argv.indexOf("--session");
  const session = si >= 0 ? argv[si + 1] : undefined;
  if (si >= 0 && (!session || session.startsWith("--"))) {
    console.error("claim: --session needs a value");
    return 2;
  }
  const id = argv.find((a, i) => !a.startsWith("--") && (si < 0 || i !== si + 1));
  if (!id) {
    console.error("usage: pnpm claim <ITEM-ID> [--session <id>]");
    return 2;
  }
  const root = findRoot();
  if (!root) {
    console.error("claim: could not find sdlc.config.json above the current directory");
    return 2;
  }
  let dirs: Dirs = DEFAULT_DIRS;
  let integration = "dev";
  try {
    const cfg = await loadConfig(root);
    dirs = { requirements: cfg.dirs.requirements, plan: cfg.dirs.plan, adr: cfg.dirs.adr };
    integration = cfg.branches.integration;
  } catch (e) {
    console.error(
      `claim: could not load sdlc.config.json (${(e as Error).message}); using defaults`,
    );
  }
  return claim(
    id,
    { session },
    {
      root,
      integration,
      items: loadItems(root, dirs),
      exec,
      now: () => new Date(),
      log: (l) => console.log(l),
    },
  );
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
