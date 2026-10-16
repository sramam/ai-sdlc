/**
 * `pnpm promote <env> [--sha <ref>] [--dry-run] [--yes]` — move an environment
 * forward by fast-forward, from a commit `local-ci` already passed.
 *
 * docs/kit/environments.md § Deploying, with no hosted CI, performed in order,
 * one printed line per step:
 *
 *   1. config      the environment exists; its source is the branch before its
 *                  own in integration → staging → production
 *   2. clean       refuse a dirty tree
 *   3. fetch       git fetch origin
 *   4. source      origin/<source>, or --sha if it is on origin/<source>
 *   5. local-ci    refuse unless that SHA has `local-ci` = success. The
 *                  `local-ci/allow-unknown` override does not count
 *   6. ff          refuse unless origin/<target> is an ancestor of the SHA —
 *                  fast-forward only, never a merge, never a PR into main
 *   7. push-check  `git push --dry-run` of the exact push step 12 makes, so the
 *                  pre-push hook and the remote answer before anything changes
 *   8. approval    requiresApproval: print the plan and stop unless --yes
 *                  (--dry-run stops here too, exit 0)
 *   9. checkout    a shared clone of this repository in a temp dir, detached at
 *                  the SHA — the working tree is never what is deployed
 *  10. install     pnpm install --frozen-lockfile in it, when it has a lockfile
 *  11. migrate     the environment's migrate command; failure stops before deploy
 *  12. deploy      the environment's deploy command, in the checkout
 *  13. push        git push origin <sha>:refs/heads/<target> — never forced
 *  14. smoke       the smoke command and/or GET smokeUrl (< 400); fails loudly
 *
 * Migrate runs before deploy and push, because rollback moves code back and
 * leaves the schema forward (docs/kit/sdlc.md § Branches and promotion).
 *
 * Exit 0 promoted (or a dry run) · 1 refused or failed · 2 could not ask.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec, isEntry } from "../../core/src/exec.mts";
import type { Exec, ExecOptions } from "../../core/src/exec.mts";
import { findRoot, loadConfig as realLoadConfig } from "../../core/src/config.mts";
import type { EnvironmentConfig, SdlcConfig } from "../../core/src/config.mts";
import { exitFor, localCiVerdict, reporter, shortSha, sourceBranch, why } from "./shared.mts";
import type { LineState } from "./shared.mts";

export interface PromoteOptions {
  env: string;
  sha?: string;
  dryRun: boolean;
  yes: boolean;
}

export interface PromoteDeps {
  exec: Exec;
  root: string;
  loadConfig: (dir: string) => Promise<SdlcConfig>;
  log: (line: string) => void;
  /** A fresh, empty directory for the checkout. */
  tempDir: () => string;
  /** Removes the checkout; never throws. */
  removeDir: (dir: string) => void;
  /** Whether a file exists (the checkout's lockfile). */
  exists: (path: string) => boolean;
  /** GET for the smoke URL: the status, or an error to report. */
  httpGet: (url: string) => Promise<{ status: number } | { error: string }>;
}

export interface PromoteOutcome {
  exit: number;
  stoppedAt?: string;
  sha?: string;
  /** The environment was deployed (the step ran and succeeded). */
  deployed: boolean;
  /** The target branch was moved. */
  pushed: boolean;
}

const USAGE = "usage: pnpm promote <env> [--sha <ref>] [--dry-run] [--yes]";

export function parsePromoteArgs(argv: string[]): PromoteOptions | { error: string } {
  let env: string | undefined;
  let sha: string | undefined;
  let dryRun = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes") yes = true;
    else if (a === "--sha") {
      sha = argv[++i];
      if (!sha || sha.startsWith("--")) return { error: `--sha needs a ref\n${USAGE}` };
    } else if (a?.startsWith("--")) return { error: `unknown argument: ${a}\n${USAGE}` };
    else if (env === undefined) env = a;
    else return { error: `unexpected argument: ${a}\n${USAGE}` };
  }
  if (!env) return { error: USAGE };
  return { env, sha, dryRun, yes };
}

export async function runPromote(opts: PromoteOptions, deps: PromoteDeps): Promise<PromoteOutcome> {
  const { log, root } = deps;
  const line = reporter(log);
  let deployed = false;
  let pushed = false;
  let sha: string | undefined;
  const stop = (name: string, state: LineState, text: string): PromoteOutcome => {
    line(name, state, text);
    log("");
    log(
      `promote: stopped at ${name}. Nothing after it ran${deployed ? "" : "; nothing was deployed"}${pushed ? "" : ", no branch moved"}.`,
    );
    return { exit: exitFor(state), stoppedAt: name, sha, deployed, pushed };
  };
  const git = (args: string[], timeoutMs = 60_000) =>
    deps.exec("git", args, { cwd: root, timeoutMs });

  // 1. Config.
  const config = await deps.loadConfig(root);
  const envs = config.environments ?? {};
  const env: EnvironmentConfig | undefined = envs[opts.env];
  if (!env) {
    const known = Object.keys(envs);
    return stop(
      "config",
      "REFUSED",
      `no environment "${opts.env}" in sdlc.config.json${known.length ? ` (known: ${known.join(", ")})` : " — `environments` is not configured (tooling/promote/README.md)"}`,
    );
  }
  const source = sourceBranch(config, env);
  if (!source)
    return stop(
      "config",
      "REFUSED",
      `environments.${opts.env}.branch "${env.branch}" has no branch before it`,
    );
  const target = env.branch;
  log(`promote ${opts.env}: ${source} → ${target}${opts.dryRun ? " (dry run)" : ""}`);
  line("config", "ok", `${opts.env} deploys ${target}, promoted from ${source}`);

  // 2. Clean.
  const st = await git(["status", "--porcelain"]);
  if (st.code !== 0) return stop("clean", "COULD NOT ASK", `git status: ${why(st)}`);
  if (st.stdout.trim()) {
    const dirty = st.stdout.trimEnd().split("\n");
    return stop(
      "clean",
      "REFUSED",
      `the tree is dirty (${dirty.length} path(s), e.g. ${dirty[0]?.trim()}) — commit or remove first`,
    );
  }
  line("clean", "ok", "nothing uncommitted");

  // 3. Fetch.
  const f = await git(["fetch", "--quiet", "origin"], 300_000);
  if (f.code !== 0) return stop("fetch", "COULD NOT ASK", `git fetch: ${why(f)}`);
  line("fetch", "ok", "origin");

  // 4. Source.
  const srcR = await git(["rev-parse", "--verify", "--quiet", `origin/${source}^{commit}`]);
  if (srcR.notFound || srcR.timedOut) return stop("source", "COULD NOT ASK", `git: ${why(srcR)}`);
  if (srcR.code !== 0 || !srcR.stdout.trim())
    return stop("source", "REFUSED", `origin/${source} not found`);
  const sourceTip = srcR.stdout.trim();
  if (opts.sha) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${opts.sha}^{commit}`]);
    if (r.code !== 0 || !r.stdout.trim())
      return stop("source", "REFUSED", `--sha ${opts.sha} does not resolve to a commit`);
    sha = r.stdout.trim();
    if (sha !== sourceTip) {
      const on = await git(["merge-base", "--is-ancestor", sha, sourceTip]);
      if (on.code === 1)
        return stop(
          "source",
          "REFUSED",
          `${shortSha(sha)} is not on origin/${source} — only what reached ${source} is promoted to ${target}`,
        );
      if (on.code !== 0) return stop("source", "COULD NOT ASK", `git merge-base: ${why(on)}`);
    }
  } else sha = sourceTip;
  line(
    "source",
    "ok",
    sha === sourceTip
      ? `origin/${source} at ${shortSha(sha)}`
      : `${shortSha(sha)}, on origin/${source} (tip ${shortSha(sourceTip)})`,
  );

  // 5. local-ci.
  const ci = await localCiVerdict(deps.exec, root, sha);
  if (ci.verdict !== "green")
    return stop(
      "local-ci",
      ci.verdict === "unknown" && ci.couldNotAsk ? "COULD NOT ASK" : "REFUSED",
      `${ci.detail}. Promotion needs a green local-ci on the exact SHA; there is no override`,
    );
  line("local-ci", "ok", ci.detail);

  // 6. Fast-forward only.
  const tgtR = await git(["rev-parse", "--verify", "--quiet", `origin/${target}^{commit}`]);
  if (tgtR.notFound || tgtR.timedOut) return stop("ff", "COULD NOT ASK", `git: ${why(tgtR)}`);
  const targetTip = tgtR.code === 0 ? tgtR.stdout.trim() : "";
  let count = "?";
  if (targetTip) {
    if (targetTip === sha) {
      line("ff", "ok", `origin/${target} is already ${shortSha(sha)}`);
      log("");
      log(`promote: nothing to promote — ${target} is already at ${shortSha(sha)}.`);
      return { exit: 0, sha, deployed, pushed };
    }
    const anc = await git(["merge-base", "--is-ancestor", targetTip, sha]);
    if (anc.code === 1)
      return stop(
        "ff",
        "REFUSED",
        `origin/${target} (${shortSha(targetTip)}) is not an ancestor of ${shortSha(sha)} — not a fast-forward. Something reached ${target} other than by promotion; reconcile it into ${source} by a PR and verify the tree, never by merging into ${target}`,
      );
    if (anc.code !== 0) return stop("ff", "COULD NOT ASK", `git merge-base: ${why(anc)}`);
    const c = await git(["rev-list", "--count", `${targetTip}..${sha}`]);
    if (c.code === 0) count = c.stdout.trim();
    line("ff", "ok", `${shortSha(targetTip)} → ${shortSha(sha)}, ${count} commit(s)`);
  } else
    line(
      "ff",
      "warn",
      `origin/${target} does not exist yet — it will be created at ${shortSha(sha)}`,
    );

  // 7. Push check: the same push, dry-run, so the hook and the remote answer now.
  const refspec = `${sha}:refs/heads/${target}`;
  const dry = await git(["push", "--dry-run", "--porcelain", "origin", refspec], 120_000);
  if (dry.code !== 0) {
    const said = `${dry.stderr}\n${dry.stdout}`;
    if (/pre-push/i.test(said))
      return stop(
        "push-check",
        "REFUSED",
        `the pre-push hook refuses \`git push origin ${refspec}\` — see tooling/promote/README.md § The pre-push hook`,
      );
    return stop(
      "push-check",
      dry.notFound || dry.timedOut ? "COULD NOT ASK" : "REFUSED",
      `git push --dry-run: ${why(dry)}`,
    );
  }
  line(
    "push-check",
    "ok",
    `git push origin ${shortSha(sha)}:refs/heads/${target} would be accepted`,
  );

  // 8. The plan; approval.
  const plan = [
    `checkout ${shortSha(sha)} in a temporary shared clone`,
    env.migrate ? `migrate: ${env.migrate}` : "migrate: none configured",
    `deploy: ${env.deploy}`,
    `push: git push origin ${shortSha(sha)}:refs/heads/${target}`,
    env.smoke || env.smokeUrl
      ? `smoke: ${[env.smoke, env.smokeUrl && `GET ${env.smokeUrl}`].filter(Boolean).join(" and ")}`
      : "smoke: none configured",
  ];
  if (opts.dryRun || (env.requiresApproval && !opts.yes)) {
    for (const p of plan) line("approval", "plan", p);
    log("");
    if (opts.dryRun) {
      log(`promote: dry run — every check passed; nothing was migrated, deployed or pushed.`);
      return { exit: 0, sha, deployed, pushed };
    }
    log(
      `promote: ${opts.env} requires approval. Read the plan, then re-run with --yes: pnpm promote ${opts.env}${opts.sha ? ` --sha ${opts.sha}` : ""} --yes`,
    );
    return { exit: 1, stoppedAt: "approval", sha, deployed, pushed };
  }
  line(
    "approval",
    env.requiresApproval ? "ok" : "n/a",
    env.requiresApproval ? "--yes given" : "not required",
  );

  // 9–14 run in a checkout that is always removed.
  const dir = deps.tempDir();
  const checkout = join(dir, "checkout");
  try {
    const clone = await deps.exec(
      "git",
      ["clone", "--quiet", "--shared", "--no-checkout", root, checkout],
      {
        cwd: dir,
        timeoutMs: 300_000,
      },
    );
    if (clone.code !== 0)
      return stop("checkout", "COULD NOT ASK", `git clone --shared: ${why(clone)}`);
    const co = await deps.exec("git", ["checkout", "--quiet", "--detach", sha], {
      cwd: checkout,
      timeoutMs: 300_000,
    });
    if (co.code !== 0)
      return stop("checkout", "COULD NOT ASK", `git checkout ${shortSha(sha)}: ${why(co)}`);
    line("checkout", "ok", `${shortSha(sha)}, detached, in a temporary clone`);

    const envVars: NodeJS.ProcessEnv = {
      ...process.env,
      PROMOTE_ENV: opts.env,
      PROMOTE_SHA: sha,
      PROMOTE_BRANCH: target,
    };
    const run = (cmd: string, timeoutMs: number) => {
      const o: ExecOptions = { cwd: checkout, env: envVars, timeoutMs, echo: true };
      return deps.exec("sh", ["-c", cmd], o);
    };

    // 10. Install.
    if (deps.exists(join(checkout, "pnpm-lock.yaml"))) {
      const pnpm = (args: string[]) =>
        deps.exec("pnpm", args, { cwd: checkout, env: envVars, timeoutMs: 900_000 });
      let inst = await pnpm(["install", "--offline", "--frozen-lockfile"]);
      if (inst.code !== 0 && !inst.notFound) inst = await pnpm(["install", "--frozen-lockfile"]);
      if (inst.code !== 0)
        return stop(
          "install",
          inst.notFound || inst.timedOut ? "COULD NOT ASK" : "FAILED",
          `pnpm install --frozen-lockfile: ${why(inst)}`,
        );
      line("install", "ok", "pnpm install --frozen-lockfile");
    } else line("install", "n/a", "no pnpm-lock.yaml in the checkout");

    // 11. Migrate.
    if (env.migrate) {
      const m = await run(env.migrate, 1_800_000);
      if (m.code !== 0)
        return stop(
          "migrate",
          m.notFound || m.timedOut ? "COULD NOT ASK" : "FAILED",
          `\`${env.migrate}\` exited ${m.code ?? "on a signal"}${m.timedOut ? " (timed out)" : ""} — nothing deployed. A migration that applied partly is still applied; check the database before retrying`,
        );
      line("migrate", "ok", env.migrate);
    } else line("migrate", "n/a", "no migrate command configured");

    // 12. Deploy.
    const d = await run(env.deploy, 1_800_000);
    if (d.code !== 0)
      return stop(
        "deploy",
        d.notFound || d.timedOut ? "COULD NOT ASK" : "FAILED",
        `\`${env.deploy}\` exited ${d.code ?? "on a signal"}${d.timedOut ? " (timed out)" : ""}${env.migrate ? " — the migration has applied and stays; the schema is forward" : ""}`,
      );
    deployed = true;
    line("deploy", "ok", `${env.deploy} (${shortSha(sha)})`);

    // 13. Push.
    const p = await git(["push", "--porcelain", "origin", refspec], 300_000);
    if (p.code !== 0)
      return stop(
        "push",
        p.notFound || p.timedOut ? "COULD NOT ASK" : "FAILED",
        `git push: ${why(p)} — ${opts.env} now runs ${shortSha(sha)} while ${target} still names ${targetTip ? shortSha(targetTip) : "nothing"}. Push by hand: git push origin ${refspec}`,
      );
    pushed = true;
    line("push", "ok", `${target} → ${shortSha(sha)}`);

    // 14. Smoke.
    const rollbackHint = env.rollback ? ` Roll back with: pnpm rollback ${opts.env}` : "";
    if (!env.smoke && !env.smokeUrl)
      line("smoke", "warn", "none configured — nothing checked the deployment");
    if (env.smoke) {
      const s = await run(env.smoke, 600_000);
      if (s.code !== 0)
        return stop(
          "smoke",
          s.notFound || s.timedOut ? "COULD NOT ASK" : "FAILED",
          `\`${env.smoke}\` exited ${s.code ?? "on a signal"} — ${opts.env} is deployed and NOT confirmed working.${rollbackHint}`,
        );
      line("smoke", "ok", env.smoke);
    }
    if (env.smokeUrl) {
      const g = await deps.httpGet(env.smokeUrl);
      if ("error" in g)
        return stop(
          "smoke",
          "COULD NOT ASK",
          `GET ${env.smokeUrl}: ${g.error} — ${opts.env} is deployed and NOT confirmed working.${rollbackHint}`,
        );
      if (g.status >= 400)
        return stop(
          "smoke",
          "FAILED",
          `GET ${env.smokeUrl} answered ${g.status} — ${opts.env} is deployed and broken.${rollbackHint}`,
        );
      line("smoke", "ok", `GET ${env.smokeUrl} → ${g.status}`);
    }
  } finally {
    deps.removeDir(dir);
  }

  log("");
  log(`promote: ${opts.env} runs ${shortSha(sha)}; ${target} fast-forwarded (${count} commit(s)).`);
  return { exit: 0, sha, deployed, pushed };
}

/** A GET with a timeout, following redirects; the status or why it failed. */
export async function fetchStatus(url: string): Promise<{ status: number } | { error: string }> {
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    return { status: r.status };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function realPromoteDeps(root: string, log: (l: string) => void): PromoteDeps {
  return {
    exec: realExec,
    root,
    loadConfig: realLoadConfig,
    log,
    tempDir: () => mkdtempSync(join(tmpdir(), "promote-")),
    removeDir: (dir) => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // a leftover temp dir is harmless
      }
    },
    exists: existsSync,
    httpGet: fetchStatus,
  };
}

async function main(): Promise<void> {
  const opts = parsePromoteArgs(process.argv.slice(2));
  if ("error" in opts) {
    console.error(opts.error);
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error("promote: no sdlc.config.json above this directory");
    process.exit(1);
  }
  const outcome = await runPromote(
    opts,
    realPromoteDeps(root, (l) => console.log(l)),
  );
  process.exit(outcome.exit);
}

if (isEntry(import.meta.url)) await main();
