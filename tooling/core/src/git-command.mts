/**
 * The one git-command parser every guard shares (docs/kit/hooks.md).
 *
 * door_nexa had three copies, each matching `git` immediately followed by the
 * subcommand. `git -C <path> worktree add …` walked past two of them: `-C`
 * takes a value, and a value is neither a flag nor the subcommand. Only one
 * copy was ever fixed, which is why this is written once.
 *
 * It answers two questions: *does this command run `git <sub…>`* (one right
 * answer, no unsure case) and *where would git act* (which can be unreadable,
 * and says so with `null` rather than a plausible default).
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** git's global options that consume the token after them. */
const GIT_VALUED = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

/** The pieces a shell would run, split on `&&`, `||`, `|`, `;` and newlines. */
export function segmentsOf(command: string): string[] {
  return command.split(/&&|\|\|?|;|\n/);
}

const tokensOf = (segment: string): string[] =>
  segment
    .trim()
    .replace(/^[({]+\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
const isGit = (token: string): boolean => token === "git" || token.endsWith("/git");

/** Commands that run the next word as a command. */
const WRAPPERS = new Set(["env", "command", "exec", "time", "nohup", "sudo"]);

/**
 * Where git sits in a segment: in **command position** only — after any
 * `VAR=value` assignments and wrappers. `echo git commit` runs echo.
 */
function gitIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isGit(token)) return i;
    if (WRAPPERS.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return -1;
  }
  return -1;
}

/**
 * The tokens after `git <words…>` in this segment, or null if the segment does
 * not run exactly that subcommand path. Global options are stepped over,
 * including the ones whose value would otherwise read as the subcommand.
 */
export function subcommandArgs(segment: string, ...words: string[]): string[] | null {
  const tokens = tokensOf(segment);
  const at = gitIndex(tokens);
  if (at < 0) return null;

  let matched = 0;
  for (let i = at + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (matched === 0) {
      if (GIT_VALUED.has(token)) {
        i++; // its value, not the subcommand
        continue;
      }
      if (token.startsWith("-")) continue; // a bare flag, or --opt=value
    }
    if (token !== words[matched]) return null;
    matched++;
    if (matched === words.length) return tokens.slice(i + 1);
  }
  return null;
}

/** Does this one segment invoke `git` with exactly this subcommand path? */
export function invokesGit(segment: string, ...words: string[]): boolean {
  return subcommandArgs(segment, ...words) !== null;
}

/** The first segment invoking `git <words…>`, or null if none does. */
export function gitSegment(command: string, ...words: string[]): string | null {
  for (const segment of segmentsOf(command)) {
    if (invokesGit(segment, ...words)) return segment;
  }
  return null;
}

/**
 * A shell token with its quotes removed, or null if its value still depends on
 * the shell. `"/repo"` is readable; `"$MAIN"` is not, at any point.
 */
export function shellLiteral(token: string): string | null {
  const quoted =
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'")));
  const bare = quoted ? token.slice(1, -1) : token;
  return /[$`*"'~]/.test(bare) ? null : bare;
}

export type WorktreeAdd = {
  /** The new worktree's path, as written. */
  path?: string;
  /** `-b`/`-B`. */
  branch?: string;
  /** The commit-ish to fork from; absent means HEAD. */
  base?: string;
  /** Some token's value is the shell's, so `path`/`base` may be wrong. */
  unreadable: boolean;
};

/** `git worktree add` options that consume the next token. */
const ADD_VALUED = new Set(["-b", "-B", "--reason"]);

/**
 * The arguments of the `git worktree add` in this command, or null if it runs
 * none. Reading only — what an unreadable token *means* is the caller's call:
 * the base guard refuses on it, the registry merely leaves a field blank.
 */
export function parseWorktreeAdd(command: string): WorktreeAdd | null {
  const segment = gitSegment(command, "worktree", "add");
  if (segment === null) return null;
  const rest = subcommandArgs(segment, "worktree", "add") ?? [];

  const result: WorktreeAdd = { unreadable: false };
  const positional: string[] = [];
  const read = (token: string | undefined): string | undefined => {
    if (token === undefined) return undefined;
    const value = shellLiteral(token);
    if (value === null) {
      result.unreadable = true;
      return token;
    }
    return value;
  };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("#")) break; // a trailing comment, e.g. an override
    // A redirection (`2>&1`, `> log`, `2>/dev/null`) is the shell's, not git's.
    const redirect = /^\d*(?:>>?|<)(&\d*)?(.*)$/.exec(token);
    if (redirect) {
      if (!redirect[1] && !redirect[2]) i++; // `> log`: the target is the next token
      continue;
    }
    if (ADD_VALUED.has(token)) {
      const value = read(rest[++i]);
      if (token !== "--reason") result.branch = value;
      continue;
    }
    if (token.startsWith("-")) continue;
    const value = read(token);
    if (value !== undefined) positional.push(value);
  }

  result.path = positional[0];
  result.base = positional[1];
  return result;
}

/**
 * Where a git invocation would act — not where the session stands.
 *
 * `-C` changes directory before git runs, so `git -C "$MAIN" commit` from
 * inside a worktree lands in the main checkout. `-C` composes in order and
 * `--work-tree` overrides the result. Returns **null for could-not-tell** (a
 * shell variable), kept apart from "no option given".
 */
export function gitWorkingDir(
  segment: string,
  cwd: string,
  resolvePath: (...parts: string[]) => string = resolve,
): string | null {
  const tokens = tokensOf(segment);
  const at = gitIndex(tokens);
  if (at < 0) return cwd;

  let dir = cwd;
  let workTree: string | null = null;

  for (let i = at + 1; i < tokens.length; i++) {
    const token = tokens[i]!;

    const inline = /^--work-tree=(.*)$/.exec(token);
    if (inline) {
      const value = shellLiteral(inline[1]!);
      if (value === null) return null;
      workTree = value;
      continue;
    }

    if (token === "-C" || token === "--work-tree") {
      const value = shellLiteral(tokens[++i] ?? "");
      if (value === null || value === "") return null;
      if (token === "-C") dir = resolvePath(dir, value);
      else workTree = value;
      continue;
    }

    if (GIT_VALUED.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    break; // the subcommand: every global option is behind us
  }

  return workTree === null ? dir : resolvePath(dir, workTree);
}

// ---- Asking git, for the guards' entry points --------------------------------

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * A path with symlinks resolved as far as it exists, so `/var/…` and
 * `/private/var/…` compare equal. The not-yet-existing tail is re-appended.
 */
export function canonical(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) {
    try {
      return realpathSync.native(abs); // native: the on-disk case, too
    } catch {
      return abs;
    }
  }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(canonical(parent), basename(abs));
}

/** The nearest existing directory at or above `path`. */
function existingDir(path: string): string {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
  return dir;
}

/**
 * The main checkout (the directory holding the common `.git`), from anywhere
 * inside it or any of its linked worktrees. Null: not a repository, or no git.
 */
export function mainCheckout(cwd: string): string | null {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], existingDir(cwd));
  return common ? canonical(dirname(common)) : null;
}

/** The top of the checkout (main or linked) containing `path`, or null. */
export function checkoutRoot(path: string): string | null {
  const top = git(["rev-parse", "--show-toplevel"], existingDir(path));
  return top ? canonical(top) : null;
}

/** `git worktree list --porcelain` for the repository at `root`, or null. */
export function worktreeListPorcelain(root: string): string | null {
  return git(["worktree", "list", "--porcelain"], root);
}
