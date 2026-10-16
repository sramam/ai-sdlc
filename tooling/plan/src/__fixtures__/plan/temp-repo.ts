/**
 * Throwaway git repositories under os.tmpdir() for the plan tooling's tests.
 * Identity is set locally in each repo; nothing global is touched.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = dirname(fileURLToPath(import.meta.url));

export function tempDir(prefix = "sdlc-plan-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A copy of a fixture project (`good`, `empty`) in a fresh temp directory. */
export function copyFixture(name: string): string {
  const dir = tempDir();
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export function initRepo(dir: string, branch = "dev"): string {
  sh(dir, ["init", "-q", "-b", branch]);
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "commit.gpgsign", "false"]);
  sh(dir, ["config", "core.hooksPath", "/dev/null"]);
  return dir;
}

export function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** Stage everything and commit with `message`, optionally at a unix time. */
export function commit(dir: string, message: string, time?: number): string {
  sh(dir, ["add", "-A"]);
  const env: Record<string, string> = {};
  if (time !== undefined) {
    env.GIT_COMMITTER_DATE = `@${time} +0000`;
    env.GIT_AUTHOR_DATE = `@${time} +0000`;
  }
  sh(dir, ["commit", "-q", "--allow-empty", "-m", message], env);
  return sh(dir, ["rev-parse", "HEAD"]).trim();
}
