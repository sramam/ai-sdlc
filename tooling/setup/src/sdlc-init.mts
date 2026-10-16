/**
 * `pnpm sdlc:init [--dry-run]` — Phase 0 of docs/kit/BOOTSTRAP.md, idempotent.
 *
 * One line per step: done, already, failed, could-not-ask (or, under
 * --dry-run, "would"). Reads are always performed, so a dry run reports the
 * real state; only the changes are withheld.
 *
 * The integration branch is created **through the API**, not `git push`: the
 * pre-push hook refuses a push to dev, and it is right to.
 *
 * Branch protection is a repository ruleset named `ai-sdlc-integration` on the
 * integration branch: a pull request and the `local-ci` status are required.
 * GitHub offers rulesets on private repositories only on paid plans; there it
 * answers 403/404 and the step reports `unavailable`, not failed — merges are
 * then enforced locally, for agents, by `pnpm land` and the settings deny rules.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec, firstLine, isEntry } from "../../core/src/exec.mts";
import type { Exec, ExecResult } from "../../core/src/exec.mts";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import type { SdlcConfig } from "../../core/src/config.mts";

/**
 * `unavailable`: GitHub will not offer this on this repository's plan. Not a
 * failure — the local guards stand in — and it does not fail the run.
 */
export type InitState =
  "done" | "already" | "failed" | "could-not-ask" | "would" | "skipped" | "unavailable";

export interface InitStep {
  name: string;
  state: InitState;
  detail: string;
}

export interface InitDeps {
  exec: Exec;
  root: string;
  config: SdlcConfig;
  dryRun: boolean;
  log: (line: string) => void;
}

/** The settings BOOTSTRAP.md names: merge commits only, no hosted backlog. */
export const REPO_SETTINGS: Record<string, boolean> = {
  allow_squash_merge: false,
  allow_merge_commit: true,
  allow_rebase_merge: false,
  delete_branch_on_merge: true,
  has_issues: false,
  has_projects: false,
};

/** A path .gitattributes must route through LFS (docs/kit/testing.md § Storing it). */
export const LFS_PROBE = "docs/journeys/x.png";

function ghFailure(r: ExecResult): string {
  if (r.notFound) return "gh is not installed";
  if (r.timedOut) return "gh timed out (waiting on a prompt? run gh auth login)";
  return firstLine(r.stderr || r.stdout) || `gh exited ${r.code}`;
}

export const RULESET_NAME = "ai-sdlc-integration";
export const STATUS_CONTEXT = "local-ci";
export const RULESET_UNAVAILABLE =
  "server-side rules need a public repo or a paid plan; merges are enforced locally for agents by pnpm land and the settings deny rules";

/** The ruleset this kit asks for on the integration branch. */
export function integrationRuleset(integration: string): Record<string, unknown> {
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [`refs/heads/${integration}`], exclude: [] } },
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: STATUS_CONTEXT }],
        },
      },
    ],
  };
}

/** Does `have` (as GitHub returns it) carry everything `want` asks for? Extra defaults are fine. */
export function covers(have: unknown, want: unknown): boolean {
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || have.length !== want.length) return false;
    return want.every((w) => have.some((h) => covers(h, w)));
  }
  if (want && typeof want === "object") {
    if (!have || typeof have !== "object") return false;
    return Object.entries(want).every(([k, v]) => covers((have as Record<string, unknown>)[k], v));
  }
  return have === want;
}

/** A 403/404 from the rulesets API: the plan does not offer it here. */
const planRefusal = (r: ExecResult): boolean => /HTTP (403|404)/.test(r.stderr + r.stdout);

function json<T>(r: ExecResult): T | null {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

export async function runInit(deps: InitDeps): Promise<{ steps: InitStep[]; exit: number }> {
  const { exec, root, config, dryRun } = deps;
  const steps: InitStep[] = [];
  const add = (s: InitStep) => {
    steps.push(s);
    deps.log(`  ${s.state.padEnd(13)} ${s.name.padEnd(18)} ${s.detail}`);
  };
  const gh = (args: string[]) =>
    exec("gh", args, {
      cwd: root,
      timeoutMs: 30_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
  const change = async (name: string, args: string[], what: string): Promise<void> => {
    if (dryRun) return add({ name, state: "would", detail: `${what}: gh ${args.join(" ")}` });
    const r = await gh(args);
    add(
      r.code === 0
        ? { name, state: "done", detail: what }
        : { name, state: "failed", detail: ghFailure(r) },
    );
  };
  const { integration, production } = config.branches;

  // 1. Which repository.
  const view = await gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
  const repo =
    view.code === 0
      ? json<{ nameWithOwner: string; defaultBranchRef: { name: string } | null }>(view)
      : null;
  if (!repo?.nameWithOwner) {
    add({
      name: "repository",
      state: "could-not-ask",
      detail: `${ghFailure(view)} — is there a GitHub remote, and is gh logged in?`,
    });
    for (const n of ["integration branch", "default branch", "settings", "actions", "ruleset"]) {
      add({ name: n, state: "could-not-ask", detail: "no repository to ask" });
    }
  } else {
    const r = repo.nameWithOwner;
    add({ name: "repository", state: "already", detail: r });

    // 2. The integration branch, created from production on GitHub.
    const branch = await gh(["api", `repos/${r}/branches/${integration}`]);
    if (branch.code === 0)
      add({ name: "integration branch", state: "already", detail: `${integration} exists` });
    else if (!/HTTP 404|Branch not found/i.test(branch.stderr + branch.stdout)) {
      add({ name: "integration branch", state: "could-not-ask", detail: ghFailure(branch) });
    } else {
      const prod = await gh([
        "api",
        `repos/${r}/git/ref/heads/${production}`,
        "--jq",
        ".object.sha",
      ]);
      const sha = prod.stdout.trim();
      if (prod.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
        add({
          name: "integration branch",
          state: "failed",
          detail: `${production} has no commit on GitHub — push ${production} first`,
        });
      } else {
        await change(
          "integration branch",
          ["api", `repos/${r}/git/refs`, "-f", `ref=refs/heads/${integration}`, "-f", `sha=${sha}`],
          `created ${integration} at ${production} (${sha.slice(0, 12)})`,
        );
      }
    }

    // 3. Default branch.
    if (repo.defaultBranchRef?.name === integration) {
      add({ name: "default branch", state: "already", detail: integration });
    } else {
      await change(
        "default branch",
        ["api", "-X", "PATCH", `repos/${r}`, "-f", `default_branch=${integration}`],
        `set to ${integration}`,
      );
    }

    // 4. Repository settings.
    const current = await gh(["api", `repos/${r}`]);
    const have = current.code === 0 ? json<Record<string, unknown>>(current) : null;
    if (!have) add({ name: "settings", state: "could-not-ask", detail: ghFailure(current) });
    else {
      const wrong = Object.entries(REPO_SETTINGS).filter(([k, v]) => have[k] !== v);
      if (wrong.length === 0)
        add({
          name: "settings",
          state: "already",
          detail: "squash off, merge commits on, issues/projects off",
        });
      else {
        const args = [
          "api",
          "-X",
          "PATCH",
          `repos/${r}`,
          ...wrong.flatMap(([k, v]) => ["-F", `${k}=${v}`]),
        ];
        await change("settings", args, wrong.map(([k, v]) => `${k}=${v}`).join(", "));
      }
    }

    // 5. Actions off: CI is local, and costs nothing (docs/kit/tech-stack.md).
    const perms = await gh(["api", `repos/${r}/actions/permissions`]);
    const p = perms.code === 0 ? json<{ enabled: boolean }>(perms) : null;
    if (!p) add({ name: "actions", state: "could-not-ask", detail: ghFailure(perms) });
    else if (p.enabled === false) add({ name: "actions", state: "already", detail: "disabled" });
    else
      await change(
        "actions",
        ["api", "-X", "PUT", `repos/${r}/actions/permissions`, "-F", "enabled=false"],
        "disabled",
      );

    // 6. Branch protection: a ruleset on the integration branch.
    const list = await gh(["api", `repos/${r}/rulesets`]);
    const rulesets = list.code === 0 ? json<Array<{ id: number; name: string }>>(list) : null;
    if (list.code !== 0 && planRefusal(list))
      add({ name: "ruleset", state: "unavailable", detail: RULESET_UNAVAILABLE });
    else if (!rulesets) add({ name: "ruleset", state: "could-not-ask", detail: ghFailure(list) });
    else {
      const want = integrationRuleset(integration);
      const found = rulesets.find((x) => x.name === RULESET_NAME);
      let current: unknown = null;
      if (found) {
        const one = await gh(["api", `repos/${r}/rulesets/${found.id}`]);
        current = one.code === 0 ? json<unknown>(one) : null;
      }
      const what = `${integration}: pull request and ${STATUS_CONTEXT} status required`;
      if (found && current && covers(current, want))
        add({ name: "ruleset", state: "already", detail: `${RULESET_NAME} (${what})` });
      else {
        const args = found
          ? ["api", "-X", "PUT", `repos/${r}/rulesets/${found.id}`]
          : ["api", "-X", "POST", `repos/${r}/rulesets`];
        const verb = found ? "updated" : "created";
        if (dryRun)
          add({
            name: "ruleset",
            state: "would",
            detail: `${verb.replace(/d$/, "")} ${RULESET_NAME}: gh ${args.join(" ")}`,
          });
        else {
          const dir = mkdtempSync(join(tmpdir(), "sdlc-ruleset-"));
          const body = join(dir, "ruleset.json");
          try {
            writeFileSync(body, JSON.stringify(want));
            const res = await gh([...args, "--input", body]);
            add(
              res.code === 0
                ? { name: "ruleset", state: "done", detail: `${verb} ${RULESET_NAME} (${what})` }
                : planRefusal(res)
                  ? { name: "ruleset", state: "unavailable", detail: RULESET_UNAVAILABLE }
                  : { name: "ruleset", state: "failed", detail: ghFailure(res) },
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  }

  // 7. Fetch, so origin/<integration> exists locally.
  if (dryRun) add({ name: "fetch", state: "would", detail: "git fetch --prune origin" });
  else {
    const f = await exec("git", ["fetch", "--prune", "origin"], { cwd: root, timeoutMs: 120_000 });
    add(
      f.code === 0
        ? { name: "fetch", state: "done", detail: "origin" }
        : { name: "fetch", state: "failed", detail: firstLine(f.stderr) || `exit ${f.code}` },
    );
  }

  // 8. Git LFS: journeys commit screenshots through it. Installed is not enough:
  //    the patterns in .gitattributes must actually route the evidence to LFS.
  const lfs = await exec("git", ["lfs", "version"], { cwd: root, timeoutMs: 15_000 });
  if (lfs.code !== 0) {
    add({
      name: "git-lfs",
      state: "failed",
      detail: "not installed — brew install git-lfs, then re-run",
    });
  } else {
    const hooked = await exec("git", ["config", "--local", "--get", "filter.lfs.clean"], {
      cwd: root,
      timeoutMs: 15_000,
    });
    if (hooked.code === 0 && hooked.stdout.trim())
      add({ name: "git-lfs", state: "already", detail: "installed in this repository" });
    else if (dryRun) add({ name: "git-lfs", state: "would", detail: "git lfs install --local" });
    else {
      const i = await exec("git", ["lfs", "install", "--local"], { cwd: root, timeoutMs: 30_000 });
      add(
        i.code === 0
          ? { name: "git-lfs", state: "done", detail: "git lfs install --local" }
          : { name: "git-lfs", state: "failed", detail: firstLine(i.stderr) },
      );
    }
  }
  const probe = LFS_PROBE;
  const attr = await exec("git", ["check-attr", "filter", "--", probe], {
    cwd: root,
    timeoutMs: 15_000,
  });
  if (attr.code !== 0)
    add({
      name: "lfs patterns",
      state: "could-not-ask",
      detail: firstLine(attr.stderr) || `git check-attr exited ${attr.code}`,
    });
  else if (/: filter: lfs\s*$/m.test(attr.stdout))
    add({ name: "lfs patterns", state: "already", detail: `${probe} is stored in LFS` });
  else
    add({
      name: "lfs patterns",
      state: "failed",
      detail: `${probe} is not routed to LFS (${firstLine(attr.stdout)}) — .gitattributes needs docs/journeys/**/*.png filter=lfs diff=lfs merge=lfs -text`,
    });

  // 9–10. The two checks, by running them.
  for (const [name, script, args] of [
    ["bootstrap", "tooling/setup/src/bootstrap.mts", []],
    ["ci:local", "tooling/ci/src/ci-local.mts", ["--no-status"]],
  ] as const) {
    const cmd = `node ${script} ${args.join(" ")}`.trim();
    if (dryRun) {
      add({ name, state: "would", detail: cmd });
      continue;
    }
    const r = await exec("node", [join(root, script), ...args], {
      cwd: root,
      timeoutMs: 30 * 60_000,
    });
    const out = (r.stdout + r.stderr).trimEnd();
    if (out) deps.log(out.replace(/^/gm, "      | "));
    add(
      r.code === 0
        ? { name, state: "done", detail: cmd }
        : r.code === 2
          ? { name, state: "could-not-ask", detail: `${cmd} could not answer everything (above)` }
          : { name, state: "failed", detail: `${cmd} exited ${r.code ?? "on a timeout"} (above)` },
    );
  }

  const bad = steps.filter((s) => s.state === "failed" || s.state === "could-not-ask").length;
  deps.log(
    bad ? `  ${bad} step(s) need attention` : dryRun ? "  dry run — nothing changed" : "  done",
  );
  return { steps, exit: bad ? 1 : 0 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const bad = args.filter((a) => a !== "--dry-run");
  if (bad.length) {
    console.error(`unknown argument: ${bad.join(" ")}\nusage: pnpm sdlc:init [--dry-run]`);
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error("sdlc:init: no sdlc.config.json above this directory");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  console.log(`sdlc:init${dryRun ? " (dry run)" : ""}`);
  const { exit } = await runInit({
    exec: realExec,
    root,
    config: await loadConfig(root),
    dryRun,
    log: (l) => console.log(l),
  });
  process.exit(exit);
}

if (isEntry(import.meta.url)) await main();
