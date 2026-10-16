/**
 * What promote, rollback and release share: the `local-ci` verdict for a
 * commit, the one-line step reporter, and the branch chain.
 */
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstLine } from "../../core/src/exec.mts";
import type { Exec, ExecResult } from "../../core/src/exec.mts";
import type { EnvironmentConfig, SdlcConfig } from "../../core/src/config.mts";
import { OVERRIDE_CONTEXT, STATUS_CONTEXT } from "../../ci/src/ci-local.mts";

export { OVERRIDE_CONTEXT, STATUS_CONTEXT };

/** Three answers, and each step says which. */
export type LineState = "ok" | "REFUSED" | "FAILED" | "COULD NOT ASK" | "warn" | "n/a" | "plan";

export function reporter(log: (line: string) => void) {
  return (name: string, state: LineState, text: string) =>
    log(`  ${state.padEnd(13)} ${name.padEnd(12)} ${text}`);
}

/** Exit code for a stopping state: 2 when the instrument failed, 1 otherwise. */
export const exitFor = (state: LineState): number => (state === "COULD NOT ASK" ? 2 : 1);

export const why = (r: ExecResult): string =>
  r.notFound ? "not installed" : r.timedOut ? "timed out" : firstLine(r.stderr || r.stdout, 120);

export const ghEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GH_PROMPT_DISABLED: "1" });

export type CiVerdict =
  | { verdict: "green"; detail: string }
  | { verdict: "red"; detail: string }
  | { verdict: "unknown"; detail: string; couldNotAsk: boolean };

/**
 * The `local-ci` commit status on `sha`, read from GitHub's combined status.
 *
 * Only the exact context `local-ci` in state `success` is green. A
 * `local-ci/allow-unknown` success is somebody's override, not a pass, so it
 * reads as unknown (tooling/ci). `failure` is red; `error` (a held unknown),
 * `pending` and absence are unknown.
 */
export async function localCiVerdict(exec: Exec, root: string, sha: string): Promise<CiVerdict> {
  const r = await exec("gh", ["api", `repos/{owner}/{repo}/commits/${sha}/status`], {
    cwd: root,
    timeoutMs: 30_000,
    env: ghEnv(),
  });
  if (r.code !== 0) return { verdict: "unknown", detail: `gh api: ${why(r)}`, couldNotAsk: true };
  let statuses: Array<{ context?: string; state?: string; description?: string }>;
  try {
    const body = JSON.parse(r.stdout) as { statuses?: typeof statuses };
    statuses = Array.isArray(body.statuses) ? body.statuses : [];
  } catch {
    return { verdict: "unknown", detail: "gh api returned unreadable JSON", couldNotAsk: true };
  }
  const short = sha.slice(0, 12);
  const real = statuses.find((s) => s.context === STATUS_CONTEXT);
  if (real?.state === "success")
    return { verdict: "green", detail: `${STATUS_CONTEXT} success on ${short}` };
  if (real?.state === "failure")
    return {
      verdict: "red",
      detail: `${STATUS_CONTEXT} failure on ${short}${real.description ? ` — ${real.description}` : ""}`,
    };
  if (real)
    return {
      verdict: "unknown",
      detail: `${STATUS_CONTEXT} is ${real.state ?? "unreadable"} on ${short}${real.description ? ` — ${real.description}` : ""}`,
      couldNotAsk: false,
    };
  const override = statuses.find((s) => s.context === OVERRIDE_CONTEXT);
  return {
    verdict: "unknown",
    detail: override
      ? `only ${OVERRIDE_CONTEXT} on ${short} — an override is not a pass; run \`pnpm ci:local --sha ${short}\``
      : `no ${STATUS_CONTEXT} status on ${short} — run \`pnpm ci:local --sha ${short}\``,
    couldNotAsk: false,
  };
}

/**
 * The branch an environment is promoted from: the one before its branch in
 * integration → staging → production. Null when the branch is not in the chain
 * after integration (validateConfig refuses that).
 */
export function sourceBranch(config: SdlcConfig, env: EnvironmentConfig): string | null {
  const { integration, staging, production } = config.branches;
  if (env.branch === staging) return integration;
  if (env.branch === production) return staging;
  return null;
}

export const shortSha = (sha: string): string => sha.slice(0, 12);

// ─── The pre-push handoff ─────────────────────────────────────────────────────

/** Under the git common dir, so every worktree of the repository sees one file. */
export const HANDOFF_FILE = "sdlc-promote-handoff";
/** The variable the nonce travels in, set on the one git push that needs it. */
export const NONCE_ENV = "SDLC_PROMOTE_NONCE";

/** A push the hook will accept once: the nonce for its environment, and how to withdraw it. */
export type ArmedPush = { nonce: string; disarm: () => void } | { error: string };

/**
 * Write the one-shot handoff `.husky/pre-push` consumes: `<nonce> <sha> <ref>`.
 * The hook accepts a staging or production update only when all three match
 * the push it is shown, and deletes the file whether or not they do. The
 * caller disarms after the push too, so a push the hook never saw (a network
 * failure first) leaves nothing behind.
 */
export async function armPush(
  exec: Exec,
  root: string,
  sha: string,
  ref: string,
): Promise<ArmedPush> {
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
    timeoutMs: 30_000,
  });
  const dir = r.code === 0 ? r.stdout.trim() : "";
  if (!dir) return { error: `git rev-parse --git-common-dir: ${why(r)}` };
  const path = join(dir, HANDOFF_FILE);
  const nonce = randomBytes(16).toString("hex");
  try {
    writeFileSync(path, `${nonce} ${sha} ${ref}\n`, { mode: 0o600 });
  } catch (e) {
    return { error: `could not write ${path}: ${(e as Error).message}` };
  }
  return { nonce, disarm: () => rmSync(path, { force: true }) };
}
