/**
 * `pnpm worktrees` — live worktrees, who created them, and drift.
 *
 * ```
 * pnpm worktrees                 live worktrees, created-by session, and drift
 * pnpm worktrees --close <name>  prune a finished one from the registry
 * ```
 *
 * The registry is a log, not a fact: a tree can be removed without telling it.
 * So this reconciles against `git worktree list` in both directions, and where
 * the two disagree the disagreement is the finding.
 */
import { pathToFileURL } from "node:url";
import { mainCheckout } from "../../core/src/git-command.mts";
import {
  UNKNOWN_SESSION,
  drift,
  liveWorktrees,
  pruneClosed,
  readRegistry,
  summarise,
  writeRegistry,
  type LiveWorktree,
  type RegistryEvent,
  type WorktreeRecord,
} from "./worktree-registry.mts";

const short = (session: string) =>
  session === UNKNOWN_SESSION ? UNKNOWN_SESSION : session.slice(0, 8);

export function report(records: WorktreeRecord[], live: LiveWorktree[]): string {
  const names = live.map((w) => w.name);
  const { unrecorded, orphaned } = drift(records, names);
  const lines: string[] = [`\n  Worktrees — ${live.length} live, ${records.length} recorded\n`];

  if (live.length === 0) lines.push("    (none under .claude/worktrees/)");
  else lines.push(`      ${"worktree".padEnd(24)} ${"created by".padEnd(10)} on branch`);

  for (const tree of live) {
    const record = records.find((r) => r.worktree === tree.name);
    if (!record) {
      lines.push(`    ? ${tree.name.padEnd(24)} no record — made outside the tool`);
      continue;
    }
    // The live branch, asked of git; the recorded one is only what it was created on.
    const branch = tree.branch ?? record.branch ?? "—";
    const entered = record.enteredBy.length
      ? `  entered by ${record.enteredBy.map(short).join(", ")}`
      : "";
    lines.push(
      `    ✓ ${tree.name.padEnd(24)} ${short(record.createdBy).padEnd(10)} ${branch}${entered}`,
    );
  }

  if (live.length > 0) {
    lines.push(
      "\n  `created by` is who made the tree, never who is in it now. Ask the session" +
        "\n  directly; nothing here records occupancy.",
    );
  }

  if (orphaned.length > 0) {
    lines.push("\n  Recorded, and gone from disk — close them to prune:");
    for (const record of orphaned) {
      lines.push(`    · ${record.worktree.padEnd(24)} ${short(record.createdBy)}`);
      lines.push(`      pnpm worktrees --close ${record.worktree}`);
    }
  }

  if (unrecorded.length > 0) {
    lines.push(
      `\n  ${unrecorded.length} live worktree(s) the registry never saw. They are claimed by the` +
        "\n  first session that runs a tool inside them.",
    );
  }

  if (orphaned.length === 0 && unrecorded.length === 0) {
    lines.push("\n  No drift: the registry and git agree.");
  }

  return `${lines.join("\n")}\n`;
}

export type CloseResult = { ok: boolean; message: string; events?: RegistryEvent[] };

/**
 * Pure: what closing `name` does to these events, given what git has. A tree
 * still on disk is refused — pruning its record would let its session open a
 * second one past `worktree-single`. Not knowing what git has is refused too.
 */
export function closeVerdict(
  events: RegistryEvent[],
  name: string,
  live: LiveWorktree[] | null,
): CloseResult {
  if (live === null) {
    return {
      ok: false,
      message: `  ${name}: could not ask git which worktrees exist. Nothing pruned.\n`,
    };
  }
  if (live.some((w) => w.name === name)) {
    return {
      ok: false,
      message:
        `  ${name}: still on disk. Remove it first, then close it:\n\n` +
        `    git worktree remove .claude/worktrees/${name}\n` +
        `    pnpm worktrees --close ${name}\n`,
    };
  }
  if (!events.some((e) => e.worktree === name)) {
    return { ok: true, message: `  ${name}: nothing recorded. Nothing to prune.\n` };
  }
  return { ok: true, message: `  ${name}: pruned.\n`, events: pruneClosed(events, name) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const root = mainCheckout(process.cwd());
  if (!root) {
    console.error("  Not inside a git repository — there is no registry to read.");
    process.exit(1);
  }

  const at = args.indexOf("--close");
  if (at >= 0) {
    const name = args[at + 1];
    if (!name) {
      console.error("  --close needs a worktree name. `pnpm worktrees` lists them.");
      process.exit(1);
    }
    const result = closeVerdict(readRegistry(root), name, liveWorktrees(root));
    if (result.events) writeRegistry(root, result.events);
    process.stdout.write(result.message);
    process.exit(result.ok ? 0 : 1);
  }

  const live = liveWorktrees(root);
  if (live === null) {
    console.error("  Could not run `git worktree list`; drift cannot be checked.");
    process.exit(1);
  }
  process.stdout.write(report(summarise(readRegistry(root)), live));
}
