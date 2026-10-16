/**
 * The one git-command parser every guard shares (docs/kit/hooks.md).
 *
 * An earlier project had three copies, each matching `git` immediately
 * followed by the subcommand. `git -C <path> worktree add …` walked past two
 * of them: `-C` takes a value, and a value is neither a flag nor the
 * subcommand. Only one copy was ever fixed, which is why this is written once.
 *
 * It answers two questions: *does this command run `git <sub…>`* (one right
 * answer, no unsure case) and *where would git act* (which can be unreadable,
 * and says so with `null` rather than a plausible default).
 *
 * **A guardrail against accidents, not a security boundary.** It reads the
 * shell the way an agent ordinarily writes it — quotes, `&&`/`;`/`|`, `$(…)`
 * and backticks, `bash -c '…'`, `eval`, heredocs fed to a shell, and the
 * wrappers that run their argument (`env`, `command`, `exec`, `nice`, `nohup`,
 * `time`, `timeout`, `xargs`, `sudo`, `pnpm exec`/`dlx`, `npx`). It does not
 * follow aliases, functions, variables holding a command (`G=git; $G commit`),
 * scripts read from a file or piped into a shell (`echo … | sh`), or another
 * interpreter (`node -e`, `python -c`). Anybody determined to run git past it
 * can; what it stops is the ordinary command that would have done harm by
 * mistake. Server-side and pre-push rules are the boundary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
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

/** How deep `bash -c`, `$(…)` and friends are followed. Deeper is not read. */
const MAX_DEPTH = 6;

// ---- Reading the shell -------------------------------------------------------

/** A command between separators, and the heredoc bodies fed to it. */
type Piece = { text: string; bodies: string[] };

type Scan = { pieces: Piece[]; nested: string[]; end: number };

/**
 * Split `s` from `start` into the commands a shell would run, quote-aware.
 * Separators are `&&`, `||`, `|`, `|&`, `;`, `&`, newlines and bare
 * parentheses; none of them count inside quotes, a comment or a heredoc.
 * Command and process substitutions are scanned in place, and what they run
 * is returned in `nested`. With `closer`, an unmatched `)` ends the scan.
 */
function scan(s: string, start: number, depth: number, closer: boolean): Scan {
  const pieces: Piece[] = [];
  const nested: string[] = [];
  let cur: Piece = { text: "", bodies: [] };
  let parens = 0;
  let pending: { delim: string; strip: boolean; piece: Piece }[] = [];

  const flush = (): void => {
    if (cur.text.trim()) pieces.push(cur);
    cur = { text: "", bodies: [] };
  };
  /** `$(…)` from the index just after its `(`; the index after its `)`. */
  const substitution = (from: number): number => {
    const inner = scan(s, from, depth + 1, true);
    if (depth < MAX_DEPTH) nested.push(...expand(inner, depth + 1));
    return inner.end;
  };
  /** A backtick substitution starting at `at`; the index after its closer. */
  const backtick = (at: number): number => {
    let j = at + 1;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    if (depth < MAX_DEPTH)
      nested.push(...segmentsAt(s.slice(at + 1, j).replace(/\\`/g, "`"), depth + 1));
    return Math.min(j + 1, s.length);
  };
  /** A double-quoted string starting at `at`; the index after its closer. */
  const doubleQuoted = (at: number): number => {
    let j = at + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === "\\") j += 2;
      else if (c === '"') return j + 1;
      else if (c === "`") j = backtick(j);
      else if (c === "$" && s[j + 1] === "(") j = substitution(j + 2);
      else j++;
    }
    return s.length;
  };
  /** Heredoc bodies start on the line after their operator. */
  const readBodies = (from: number): number => {
    let i = from;
    for (const h of pending) {
      const lines: string[] = [];
      while (i < s.length) {
        const nl = s.indexOf("\n", i);
        const line = s.slice(i, nl < 0 ? s.length : nl);
        i = nl < 0 ? s.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      h.piece.bodies.push(lines.join("\n"));
    }
    pending = [];
    return i;
  };

  let i = start;
  while (i < s.length) {
    const c = s[i]!;
    const next = s[i + 1];
    if (c === "\\") {
      if (next !== "\n") cur.text += s.slice(i, i + 2); // a line continuation is nothing
      i += 2;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j + 1;
      cur.text += s.slice(i, end);
      i = end;
    } else if (c === '"') {
      const end = doubleQuoted(i);
      cur.text += s.slice(i, end);
      i = end;
    } else if (c === "`") {
      const end = backtick(i);
      cur.text += s.slice(i, end);
      i = end;
    } else if ((c === "$" || c === "<" || c === ">") && next === "(") {
      const end = substitution(i + 2);
      cur.text += s.slice(i, end);
      i = end;
    } else if (c === "<" && next === "<" && s[i + 2] !== "<") {
      let j = i + 2;
      const strip = s[j] === "-";
      if (strip) j++;
      while (s[j] === " " || s[j] === "\t") j++;
      let k = j;
      while (k < s.length && !/[\s;&|<>()]/.test(s[k]!)) {
        if (s[k] === "'" || s[k] === '"') {
          const q = s.indexOf(s[k]!, k + 1);
          k = q < 0 ? s.length : q + 1;
        } else k++;
      }
      const delim = unquote(s.slice(j, k));
      if (delim) pending.push({ delim, strip, piece: cur });
      cur.text += s.slice(i, k);
      i = k;
    } else if (c === "#" && (cur.text === "" || /\s$/.test(cur.text))) {
      const nl = s.indexOf("\n", i);
      const end = nl < 0 ? s.length : nl;
      cur.text += s.slice(i, end);
      i = end;
    } else if (c === "\n") {
      flush();
      i = readBodies(i + 1);
    } else if (c === "(") {
      flush();
      parens++;
      i++;
    } else if (c === ")") {
      flush();
      if (parens === 0 && closer) return { pieces, nested, end: i + 1 };
      parens = Math.max(0, parens - 1);
      i++;
    } else if (c === ";" || c === "|") {
      flush();
      i += next === c || (c === "|" && next === "&") ? 2 : 1;
    } else if (c === "&") {
      const prev = cur.text.at(-1);
      if (prev === ">" || prev === "<" || next === ">") {
        cur.text += c; // a redirection: `2>&1`, `&>log`
        i++;
      } else {
        flush();
        i += next === "&" ? 2 : 1;
      }
    } else {
      cur.text += c;
      i++;
    }
  }
  flush();
  return { pieces, nested, end: s.length };
}

/** A shell word's value with its quoting removed; expansions are left as text. */
export function unquote(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === "\\") {
      out += raw[i + 1] ?? "";
      i += 2;
    } else if (c === "'") {
      const j = raw.indexOf("'", i + 1);
      const end = j < 0 ? raw.length : j;
      out += raw.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === "\\" && '"\\$`\n'.includes(raw[i + 1] ?? "x")) {
          out += raw[i + 1];
          i += 2;
        } else out += raw[i++];
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The words of one command, quotes kept, split on unquoted whitespace. */
function tokensOf(segment: string): string[] {
  // A segment handed in whole may still open a subshell or group: `(git …`.
  const s = segment.trim().replace(/^[({]+\s*/, "");
  const tokens: string[] = [];
  let cur = "";
  let i = 0;
  const push = () => {
    if (cur) tokens.push(cur);
    cur = "";
  };
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      push();
      i++;
    } else if (c === "#" && cur === "") {
      // A comment: kept as words, so an override (`# worktree-base: …`) is visible.
      tokens.push(...s.slice(i).split(/\s+/).filter(Boolean));
      return tokens;
    } else if (c === "\\") {
      cur += s.slice(i, i + 2);
      i += 2;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j + 1;
      cur += s.slice(i, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\") j += 2;
        else if (s[j] === "$" && s[j + 1] === "(") j = scan(s, j + 2, MAX_DEPTH, true).end;
        else j++;
      }
      const end = Math.min(j + 1, s.length);
      cur += s.slice(i, end);
      i = end;
    } else if (c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, s.length);
      cur += s.slice(i, end);
      i = end;
    } else if ((c === "$" || c === "<" || c === ">") && s[i + 1] === "(") {
      const end = scan(s, i + 2, MAX_DEPTH, true).end;
      cur += s.slice(i, end);
      i = end;
    } else {
      cur += c;
      i++;
    }
  }
  push();
  return tokens;
}

const isGit = (token: string): boolean => {
  const word = unquote(token);
  return word === "git" || word.endsWith("/git");
};

/** Shell words that precede a command without being it. */
const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Wrapper = {
  /** Options that consume the next token. */
  valued?: string[];
  /** Positional arguments before the command (`timeout DURATION`). */
  positionals?: number;
  /** For a package runner: the subcommands that run a command (`pnpm exec`). */
  subcommands?: string[];
  /** Options whose value is a shell script (`npx -c '…'`, `env -S '…'`). */
  script?: string[];
  /** Options after which the wrapper does not run the command (`command -v`). */
  stops?: string[];
};

/** Commands that run the command named by their arguments. */
const WRAPPERS: Record<string, Wrapper> = {
  env: { valued: ["-u", "--unset", "-C", "--chdir"], script: ["-S", "--split-string"] },
  command: { stops: ["-v", "-V"] },
  builtin: {},
  exec: { valued: ["-a"] },
  time: {},
  nohup: {},
  nice: { valued: ["-n", "--adjustment"] },
  sudo: { valued: ["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-D"] },
  doas: { valued: ["-u", "-C"] },
  xargs: {
    valued: ["-n", "-I", "-L", "-P", "-s", "-E", "-d", "-a", "--max-args", "--max-procs"],
  },
  timeout: { valued: ["-s", "--signal", "-k", "--kill-after"], positionals: 1 },
  stdbuf: { valued: ["-i", "-o", "-e"] },
  npx: { valued: ["-p", "--package"], script: ["-c", "--call"] },
  pnpx: { valued: ["-p", "--package"], script: ["-c", "--call"] },
  bunx: {},
  pnpm: {
    valued: ["-C", "--dir", "-F", "--filter", "--workspace-dir"],
    subcommands: ["exec", "dlx"],
    script: ["-c", "--shell-mode"],
  },
  yarn: { valued: ["--cwd"], subcommands: ["exec", "dlx"] },
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const isRedirect = (token: string): boolean => /^\d*(?:[<>]|&>)/.test(token);

/**
 * Index of the next non-option token, stepping over options (and the values
 * of valued ones). Null when an option means the command will not run.
 */
function skipOptions(tokens: string[], from: number, w: Wrapper, scripts: string[]): number | null {
  let i = from;
  while (i < tokens.length) {
    const word = unquote(tokens[i]!);
    if (word === "--") return i + 1;
    if (!word.startsWith("-")) return i;
    if (w.stops?.includes(word)) return null;
    if (w.script?.includes(word)) {
      if (tokens[i + 1] !== undefined) scripts.push(unquote(tokens[i + 1]!));
      i += 2;
    } else i += w.valued?.includes(word) ? 2 : 1;
  }
  return i;
}

/**
 * Where the command of a segment sits — after assignments, reserved words and
 * wrappers — and any script a wrapper was handed inline. -1: no command.
 */
function commandPosition(tokens: string[]): { index: number; scripts: string[] } {
  const scripts: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const word = unquote(tokens[i]!);
    if (RESERVED.has(word) || ASSIGNMENT.test(word)) {
      i++;
      continue;
    }
    const w = WRAPPERS[basename(word)];
    if (!w) return { index: i, scripts };
    const at = i;
    let next: number | null;
    if (w.subcommands) {
      next = skipOptions(tokens, i + 1, { valued: w.valued }, scripts);
      if (next === null || !w.subcommands.includes(unquote(tokens[next] ?? ""))) {
        return { index: at, scripts }; // `pnpm test`: pnpm is the command
      }
      next = skipOptions(tokens, next + 1, { script: w.script }, scripts);
    } else next = skipOptions(tokens, i + 1, w, scripts);
    if (next === null) return { index: -1, scripts };
    i = next + (w.positionals ?? 0);
  }
  return { index: -1, scripts };
}

/**
 * The scripts a segment runs in a nested shell: `bash -c '…'`, `eval …`,
 * a heredoc fed to a shell, and the inline scripts of wrappers.
 */
function innerScripts(piece: Piece): string[] {
  const tokens = tokensOf(piece.text);
  const { index, scripts } = commandPosition(tokens);
  if (index < 0) return scripts;
  const cmd = basename(unquote(tokens[index]!));
  if (cmd === "eval")
    return [
      ...scripts,
      tokens
        .slice(index + 1)
        .map(unquote)
        .join(" "),
    ];
  if (!SHELLS.has(cmd)) return scripts;

  let j = index + 1;
  let sawC = false;
  while (j < tokens.length) {
    const word = unquote(tokens[j]!);
    if (isRedirect(word)) {
      j++;
      continue;
    }
    if (word === "--") {
      j++;
      break;
    }
    if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.startsWith("-") && word.includes("c")) sawC = true;
      j += /^[-+][oO]$/.test(word) ? 2 : 1;
      continue;
    }
    break;
  }
  const positional = tokens.slice(j).find((t) => !isRedirect(unquote(t)));
  if (sawC && positional !== undefined) return [...scripts, unquote(positional)];
  // `bash <<EOF … EOF` runs its body; `bash script.sh` runs a file we cannot read.
  if (!sawC && positional === undefined) return [...scripts, ...piece.bodies];
  return scripts;
}

function expand(result: Scan, depth: number): string[] {
  const out: string[] = [];
  for (const piece of result.pieces) {
    out.push(piece.text);
    if (depth < MAX_DEPTH)
      for (const script of innerScripts(piece)) out.push(...segmentsAt(script, depth + 1));
  }
  out.push(...result.nested);
  return out;
}

function segmentsAt(command: string, depth: number): string[] {
  return expand(scan(command, 0, depth, false), depth);
}

/**
 * Every command a shell would run for this text, one string each: the
 * top-level commands between separators, then whatever they run in a nested
 * shell or a substitution. Quoted separators do not split.
 */
export function segmentsOf(command: string): string[] {
  return segmentsAt(command, 0);
}

/**
 * Where git sits in a segment: in **command position** only — after any
 * `VAR=value` assignments and wrappers. `echo git commit` runs echo.
 */
function gitIndex(tokens: string[]): number {
  const { index } = commandPosition(tokens);
  return index >= 0 && isGit(tokens[index]!) ? index : -1;
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
    const token = unquote(tokens[i]!);
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

/** The nearest existing directory at or above `path` (a file's own directory). */
function existingDir(path: string): string {
  let dir = resolve(path);
  if (existsSync(dir) && !statSync(dir).isDirectory()) return dirname(dir);
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
