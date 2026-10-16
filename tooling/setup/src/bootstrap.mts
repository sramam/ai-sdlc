/**
 * `pnpm bootstrap` — is this checkout ready to work in? One line per check.
 *
 * Prints on success too: a check whose normal output is silence cannot be told
 * from one that never ran (door_nexa's `pnpm doctor` ran pnpm's own built-in for
 * a year and reported nothing). Three answers per check — ok, FAIL, and
 * could-not-ask — and a could-not-ask is never quietly a pass.
 *
 * Two kinds of check, by what depends on them:
 *
 *   required        node, pnpm, git, node_modules, checkout (worktree detection),
 *                   the env links and the skill links (`.claude/skills/` →
 *                   `.agents/skills/`, repaired here). The workflow cannot run
 *                   without them, so FAIL exits 1 and could-not-ask exits 2.
 *   informational   gh, git-lfs, claude-security. Only some steps need them —
 *                   gh for sdlc:init and land, git-lfs for committing journey
 *                   evidence, the security plugin for reviews and /ship — so a
 *                   missing or unanswering one is a `warn` line and never fails
 *                   the run. sdlc:init checks git-lfs properly where it matters.
 *
 * It also lists the newest day's handoffs, which a new session picks up first.
 * Run as the SessionStart hook (`--session-start`), its output is the
 * session's first context and it always exits 0.
 *
 * Exit: 1 if any required check failed, else 2 if any required check could
 * not ask, else 0.
 *
 * In a linked worktree it also symlinks the gitignored env files from the main
 * checkout. A symlink, never a copy: a copy keeps a rotated key and misses a new
 * variable, and fails as "authenticated as nobody", which reads as a code bug.
 * Their contents are never read.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { exec as realExec, firstLine, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { findRoot } from "../../core/src/config.mts";
import { ensureSkillLinks } from "../../core/src/skill-links.mjs";

export type CheckState = "ok" | "fail" | "could-not-ask" | "warn" | "n/a";

/** Checks that only inform: a failure is a warning (see the header). */
export const INFORMATIONAL = new Set(["gh", "git-lfs", "claude-security"]);

/** A plugin the project declares in `.claude/settings.json` and bootstrap checks for. */
export const SECURITY_PLUGIN = "claude-security@claude-plugins-official";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
}

export interface BootstrapDeps {
  exec: Exec;
  root: string;
  nodeVersion: string;
  log: (line: string) => void;
  /** Injected in tests; real one creates a relative symlink. */
  symlink?: (target: string, path: string) => void;
}

export const LINKED_ENV_FILES = [".dev.vars", ".env"];

function major(v: string): string {
  return v.replace(/^v/, "").split(".")[0] ?? "";
}

export function checkNode(nodeVersion: string, nvmrc: string | null): Check {
  if (nvmrc === null)
    return { name: "node", state: "n/a", detail: `${nodeVersion} (no .nvmrc to compare)` };
  const want = nvmrc.trim().replace(/^v/, "");
  const have = nodeVersion.replace(/^v/, "");
  // `.nvmrc` may name a major ("24") or an exact version ("24.3.0").
  const ok = want.includes(".") ? have === want : major(have) === major(want);
  return ok
    ? { name: "node", state: "ok", detail: `${nodeVersion} (.nvmrc ${want})` }
    : { name: "node", state: "fail", detail: `${nodeVersion}, but .nvmrc wants ${want} — nvm use` };
}

export function checkPnpm(have: string | null, packageManager: string | null): Check {
  if (have === null)
    return { name: "pnpm", state: "fail", detail: "not installed — corepack enable" };
  const want = packageManager?.startsWith("pnpm@") ? packageManager.slice(5).split("+")[0] : null;
  if (!want) return { name: "pnpm", state: "ok", detail: `${have} (no packageManager pin)` };
  if (have === want)
    return { name: "pnpm", state: "ok", detail: `${have} (packageManager ${want})` };
  if (major(have) === major(want))
    return { name: "pnpm", state: "ok", detail: `${have}; packageManager pins ${want}` };
  return {
    name: "pnpm",
    state: "fail",
    detail: `${have}, but packageManager pins ${want} — corepack enable`,
  };
}

async function tool(
  deps: BootstrapDeps,
  name: string,
  cmd: string,
  args: string[],
  fix: string,
): Promise<Check> {
  const r = await deps.exec(cmd, args, { cwd: deps.root, timeoutMs: 15_000 });
  if (r.notFound) return { name, state: "fail", detail: `not installed — ${fix}` };
  if (r.timedOut) return { name, state: "could-not-ask", detail: "timed out" };
  if (r.code !== 0) {
    // `git lfs` with no git-lfs installed is git refusing an unknown command.
    if (/is not a git command/.test(r.stderr))
      return { name, state: "fail", detail: `not installed — ${fix}` };
    return {
      name,
      state: "could-not-ask",
      detail: firstLine(r.stderr || r.stdout) || `exit ${r.code}`,
    };
  }
  return { name, state: "ok", detail: firstLine(r.stdout || r.stderr) };
}

/** Where the main checkout is, when this is a linked worktree. */
export async function worktreeInfo(
  deps: Pick<BootstrapDeps, "exec" | "root">,
): Promise<
  { kind: "main" } | { kind: "worktree"; main: string } | { kind: "unknown"; reason: string }
> {
  const ask = (flag: string) =>
    deps.exec("git", ["rev-parse", "--path-format=absolute", flag], {
      cwd: deps.root,
      timeoutMs: 15_000,
    });
  const [gitDir, common] = await Promise.all([ask("--git-dir"), ask("--git-common-dir")]);
  if (gitDir.code !== 0 || common.code !== 0) {
    return {
      kind: "unknown",
      reason: firstLine(gitDir.stderr || common.stderr) || "not a git repository",
    };
  }
  const g = resolve(gitDir.stdout.trim());
  const c = resolve(common.stdout.trim());
  return g === c ? { kind: "main" } : { kind: "worktree", main: dirname(c) };
}

export function linkEnvFile(
  root: string,
  main: string,
  name: string,
  symlink: (t: string, p: string) => void,
): Check {
  const here = join(root, name);
  const there = join(main, name);
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(here);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) return { name, state: "ok", detail: "linked to the main checkout" };
  if (st)
    return {
      name,
      state: "ok",
      detail: "this checkout has its own copy (a copy can drift; a symlink cannot)",
    };
  if (!existsSync(there)) return { name, state: "n/a", detail: "none in the main checkout" };
  try {
    symlink(relative(root, there), here);
    return { name, state: "ok", detail: `linked → ${there}` };
  } catch (e) {
    return { name, state: "fail", detail: `could not link: ${(e as Error).message}` };
  }
}

/**
 * Skills live in `.agents/skills/`; Claude Code sees them through symlinks in
 * `.claude/skills/`, which this repairs (a fresh clone on a filesystem that
 * dropped them, a skill added by hand). n/a when the project has no skills.
 */
export function checkSkills(root: string): Check | null {
  if (!existsSync(join(root, ".agents", "skills"))) return null;
  const r = ensureSkillLinks(root);
  if (r.failed.length)
    return { name: "skills", state: "fail", detail: `could not link ${r.failed.join("; ")}` };
  const kept = r.kept.length ? `; ${r.kept.join(", ")} not a link (the project's own)` : "";
  return {
    name: "skills",
    state: "ok",
    detail: r.created.length
      ? `linked ${r.created.length} into .claude/skills/${kept}`
      : `all visible to Claude Code${kept}`,
  };
}

/**
 * The security plugin, when `.claude/settings.json` declares it. Its license
 * lets each user install it but not the project ship it, so each machine
 * installs it once; this says when that has not happened.
 */
export async function checkSecurityPlugin(
  deps: Pick<BootstrapDeps, "exec" | "root">,
): Promise<Check | null> {
  const settings = readJson(join(deps.root, ".claude", "settings.json"));
  const enabled = settings?.enabledPlugins as Record<string, unknown> | undefined;
  if (!enabled?.[SECURITY_PLUGIN]) return null;
  const install = `claude plugin install ${SECURITY_PLUGIN} --scope project`;
  const r = await deps.exec("claude", ["plugin", "list", "--json"], {
    cwd: deps.root,
    timeoutMs: 15_000,
  });
  if (r.notFound)
    return { name: "claude-security", state: "fail", detail: `no claude CLI to ask — ${install}` };
  if (r.timedOut || r.code !== 0)
    return {
      name: "claude-security",
      state: "could-not-ask",
      detail: r.timedOut ? "timed out" : firstLine(r.stderr || r.stdout) || `exit ${r.code}`,
    };
  let ids: string[];
  try {
    ids = (JSON.parse(r.stdout) as { id?: string }[]).map((p) => p.id ?? "");
  } catch {
    return { name: "claude-security", state: "could-not-ask", detail: "unreadable plugin list" };
  }
  return ids.includes(SECURITY_PLUGIN)
    ? { name: "claude-security", state: "ok", detail: "installed" }
    : { name: "claude-security", state: "fail", detail: `not installed — ${install}` };
}

/** The newest day's handoffs in the main checkout, which a new session picks up first. */
export function newestHandoffs(main: string): { date: string; files: string[] } | null {
  const dir = join(main, "docs", "handoffs");
  if (!existsSync(dir)) return null;
  const dated = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f));
  if (!dated.length) return null;
  const date = dated
    .map((f) => f.slice(0, 10))
    .sort()
    .at(-1) as string;
  return { date, files: dated.filter((f) => f.startsWith(date)).sort() };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function runBootstrap(
  deps: BootstrapDeps,
): Promise<{ checks: Check[]; exit: number }> {
  const { root } = deps;
  const checks: Check[] = [];
  const add = (given: Check) => {
    const c: Check =
      INFORMATIONAL.has(given.name) && (given.state === "fail" || given.state === "could-not-ask")
        ? {
            ...given,
            state: "warn",
            detail: `${given.state === "fail" ? "" : "could not ask: "}${given.detail} (informational)`,
          }
        : given;
    checks.push(c);
    const label = {
      ok: "ok",
      fail: "FAIL",
      "could-not-ask": "could not ask",
      warn: "warn",
      "n/a": "n/a",
    }[c.state];
    deps.log(`  ${label.padEnd(13)} ${c.name.padEnd(14)} ${c.detail}`);
  };

  const nvmrc = existsSync(join(root, ".nvmrc"))
    ? readFileSync(join(root, ".nvmrc"), "utf8")
    : null;
  add(checkNode(deps.nodeVersion, nvmrc));

  const pm = readJson(join(root, "package.json"))?.packageManager;
  const pnpm = await deps.exec("pnpm", ["--version"], { cwd: root, timeoutMs: 15_000 });
  if (pnpm.timedOut) add({ name: "pnpm", state: "could-not-ask", detail: "timed out" });
  else
    add(checkPnpm(pnpm.notFound ? null : pnpm.stdout.trim(), typeof pm === "string" ? pm : null));

  add(await tool(deps, "git", "git", ["--version"], "install git"));
  add(
    await tool(
      deps,
      "git-lfs",
      "git",
      ["lfs", "version"],
      "brew install git-lfs, then git lfs install",
    ),
  );
  add(await tool(deps, "gh", "gh", ["--version"], "brew install gh, then gh auth login"));

  add(
    existsSync(join(root, "node_modules"))
      ? { name: "node_modules", state: "ok", detail: "present" }
      : {
          name: "node_modules",
          state: "fail",
          detail: "missing — pnpm install (never symlink it from another checkout)",
        },
  );

  const wt = await worktreeInfo(deps);
  if (wt.kind === "unknown") {
    add({ name: "checkout", state: "could-not-ask", detail: wt.reason });
  } else if (wt.kind === "main") {
    add({
      name: "checkout",
      state: "ok",
      detail: "main checkout (agents work in worktrees; see docs/kit/multi-agent.md)",
    });
  } else {
    add({ name: "checkout", state: "ok", detail: `linked worktree; main checkout is ${wt.main}` });
    const symlink = deps.symlink ?? ((t: string, p: string) => symlinkSync(t, p));
    for (const f of LINKED_ENV_FILES) add(linkEnvFile(root, wt.main, f, symlink));
  }

  const skills = checkSkills(root);
  if (skills) add(skills);
  const plugin = await checkSecurityPlugin(deps);
  if (plugin) add(plugin);
  const main = wt.kind === "worktree" ? wt.main : wt.kind === "main" ? root : null;
  const handoffs = main ? newestHandoffs(main) : null;
  if (handoffs)
    add({
      name: "handoffs",
      state: "ok",
      detail: `${handoffs.files.length} from ${handoffs.date}: ${handoffs.files.join(", ")} — pick up before any work (.agents/skills/context-engineering/pickup.md)`,
    });

  const failed = checks.filter((c) => c.state === "fail").length;
  const unknown = checks.filter((c) => c.state === "could-not-ask").length;
  const warned = checks.filter((c) => c.state === "warn").length;
  deps.log(
    `  ${failed ? `${failed} failed` : "nothing failed"}${unknown ? `, ${unknown} could not ask` : ""}${warned ? `, ${warned} warning(s)` : ""}`,
  );
  return { checks, exit: failed ? 1 : unknown ? 2 : 0 };
}

async function main(): Promise<void> {
  const root = findRoot() ?? process.cwd();
  // As a SessionStart hook its output becomes the session's first context, so
  // it names the workflow too, and it never fails the hook: a session that
  // cannot start helps nobody fix what this found.
  const sessionStart = process.argv.includes("--session-start");
  console.log(
    sessionStart
      ? `pnpm bootstrap (session start) ${root}\nThe workflow: .agents/skills/using-agent-skills/SKILL.md. Fix any FAIL below before other work.`
      : `bootstrap ${root}`,
  );
  const { exit } = await runBootstrap({
    exec: realExec,
    root,
    nodeVersion: process.version,
    log: (l) => console.log(l),
  });
  process.exit(sessionStart ? 0 : exit);
}

if (isEntry(import.meta.url)) await main();
