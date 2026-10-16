/**
 * Run a command and capture what it said, with a timeout.
 *
 * Every SDLC script reaches git, gh, pnpm or a vendor CLI through an `Exec`, so
 * a test can hand it a scripted fake and never touch a remote, a login or the
 * network. The real one closes stdin by default: a CLI that stops to ask a
 * question must time out and say so, not hang a session (docs/kit/tech-stack.md).
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface ExecResult {
  /** Exit code. 127 when the command was not found; null when killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The binary did not exist (ENOENT). Reported as code 127 as well. */
  notFound: boolean;
}

export interface ExecOptions {
  cwd?: string;
  /** The child's whole environment. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Milliseconds before the process group is killed. Default 120s. */
  timeoutMs?: number;
  /** Written to stdin, which is then closed. Without it stdin is closed at once. */
  input?: string;
  /** Echo output to this process while capturing it (long CI steps). */
  echo?: boolean;
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const DEFAULT_TIMEOUT_MS = 120_000;

export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // detached: the child leads its own process group, so a timeout kills
    // `sh -c "pnpm …"` and everything under it rather than only the shell.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (opts.echo) process.stdout.write(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      if (opts.echo) process.stderr.write(b);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
    child.on("error", (err: NodeJS.ErrnoException) => {
      const notFound = err.code === "ENOENT";
      done({
        code: notFound ? 127 : null,
        stdout,
        stderr: stderr || err.message,
        timedOut,
        notFound,
      });
    });
    child.on("close", (code) => {
      done({ code: timedOut ? null : code, stdout, stderr, timedOut, notFound: false });
    });
  });

/** A result for scripted fakes and early answers. */
export function result(code: number | null, stdout = "", stderr = ""): ExecResult {
  return { code, stdout, stderr, timedOut: false, notFound: code === 127 };
}

export interface ScriptedCall {
  cmd: string;
  args: string[];
  opts: ExecOptions;
}

/**
 * A fake `Exec` for tests: the first rule whose pattern matches
 * `"<cmd> <args…>"` answers. An unmatched command is `notFound`, which is the
 * loudest answer available — a test that forgot a rule fails rather than passes.
 */
export function scriptedExec(
  rules: Array<[RegExp | string, ExecResult | ((call: ScriptedCall) => ExecResult)]>,
): Exec & { calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const fn = async (cmd: string, args: string[], opts: ExecOptions = {}) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const line = [cmd, ...args].join(" ");
    for (const [pattern, answer] of rules) {
      const hit = typeof pattern === "string" ? line === pattern : pattern.test(line);
      if (hit) return typeof answer === "function" ? answer(call) : answer;
    }
    return {
      code: 127,
      stdout: "",
      stderr: `scriptedExec: no rule for: ${line}`,
      timedOut: false,
      notFound: true,
    };
  };
  return Object.assign(fn, { calls });
}

/** True when the module is the script node was asked to run, not an import. */
export function isEntry(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

/** First non-empty line, trimmed and bounded — for one-line reports. */
export function firstLine(text: string, max = 80): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s - m * 60)}s`;
}
