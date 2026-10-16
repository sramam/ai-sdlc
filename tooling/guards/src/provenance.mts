/**
 * prepare-commit-msg: `node tooling/guards/src/provenance.mts <msgfile>`.
 *
 * Appends `Worktree: <name>` and `Session: <id>` when committing inside
 * `.claude/worktrees/<name>`. This is the half of provenance that survives push
 * and another machine; the registry is machine-local because worktrees are.
 *
 * The session id comes from `.agent-session`, which `worktree-trace.mts` stamps
 * in the worktree — a git hook has no session context of its own.
 *
 * Silent outside a worktree, and no `Session:` without a stamp: a trailer
 * reading `unknown` on every commit teaches people to stop reading the line.
 * Deduplicated, because `--amend` and rebase re-run this over a message that
 * already carries the trailers.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*:\s/;

/** The worktree root and name containing `dir`, or null outside one. */
export function worktreeOf(dir: string): { root: string; name: string } | null {
  const match = /^(.*\/\.claude\/worktrees\/([^/]+))(?:\/|$)/.exec(dir.replace(/\\/g, "/"));
  return match ? { root: match[1]!, name: match[2]! } : null;
}

/**
 * The message with any missing trailers appended to its trailer block — or to
 * a new one after a blank line. Git's comment lines (`#`, at the end in editor
 * mode) stay below the trailers, where git will strip them.
 */
export function withTrailers(message: string, trailers: string[]): string {
  const lines = message.replace(/\n+$/, "").split("\n");

  // Peel off the trailing comment block.
  let end = lines.length;
  while (end > 0 && (lines[end - 1]!.startsWith("#") || lines[end - 1]!.trim() === "")) end--;
  const body = lines.slice(0, end);
  const comments = lines.slice(end).filter((l) => l.startsWith("#"));

  const missing = trailers.filter((t) => !body.includes(t));
  if (missing.length === 0) return message;

  // Is the last paragraph already a trailer block?
  let start = body.length;
  while (start > 0 && body[start - 1]!.trim() !== "") start--;
  const lastParagraph = body.slice(start);
  const isBlock =
    start > 0 && lastParagraph.length > 0 && lastParagraph.every((l) => TRAILER.test(l));

  // An empty body (editor mode) keeps a blank first line for the subject.
  const out = body.length === 0 ? ["", ""] : isBlock ? [...body] : [...body, ""];
  out.push(...missing);
  if (comments.length) out.push("", ...comments);
  return `${out.join("\n")}\n`;
}

/** What to append for a commit made in `dir`, or [] outside a worktree. */
export function trailersFor(dir: string): string[] {
  const tree = worktreeOf(dir);
  if (!tree) return [];
  const trailers = [`Worktree: ${tree.name}`];
  const file = join(tree.root, ".agent-session");
  if (existsSync(file)) {
    const id = (readFileSync(file, "utf8").split("\n")[0] ?? "").trim();
    if (id && id !== "unknown") trailers.push(`Session: ${id}`);
  }
  return trailers;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  try {
    const trailers = file ? trailersFor(process.cwd()) : [];
    if (file && trailers.length > 0) {
      const message = readFileSync(file, "utf8");
      const next = withTrailers(message, trailers);
      if (next !== message) writeFileSync(file, next, "utf8");
    }
  } catch (error) {
    // Provenance is worth a warning, never a refused commit.
    console.error(`provenance: trailers not added — ${(error as Error).message}`);
  }
  process.exit(0);
}
