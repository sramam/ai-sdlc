/**
 * `pnpm registry:check` — the registry end to end, against this working tree.
 * Manual, because it installs (several minutes, the network or a warm pnpm
 * store); `pnpm test` covers the CLI's logic without either.
 *
 *   1. invoke  the CLI the way a person will: `npx <dir>`, `pnpm dlx file:<dir>`,
 *              and `pnpm dlx git+file://<a committed copy>#<tag>` — the last is
 *              the github: form with only the host different
 *   2. init    a project from the committed copy (by git ref, so diff has a
 *              base to read), with pnpm install and the initial commit through
 *              the project's own hooks; then test, typecheck, lint, plan:check,
 *              and a commit through the hooks
 *   3. add     every optional module; install; the same checks; a commit
 *   4. diff and update, after changing one file here, one upstream, and one on
 *              both sides: each is classified, update applies only the
 *              untouched one, and a local edit is never overwritten
 *
 * One line per step; exit 1 if any failed. `--keep` leaves the directory.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listSourceFiles, loadRegistry } from "./registry.mjs";

const REPO = join(dirname(import.meta.filename), "..", "..");
const keep = process.argv.includes("--keep");
const work = mkdtempSync(join(tmpdir(), "registry-check-"));
const src = join(work, "source");
const proj = join(work, "proj");
const cache = join(work, "cache");

// Commits need an identity; a machine with none still gets a run.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(npm|pnpm)_config_/i.test(k)),
  ),
  XDG_CACHE_HOME: cache,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "registry check",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "registry-check@example.test",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "registry check",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "registry-check@example.test",
  CI: "1",
  NO_COLOR: "1",
};

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
function run(cwd: string, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return {
    code: r.status,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`,
  };
}
const tail = (s: string, n = 12) => s.trim().split("\n").slice(-n).join("\n");
function step(
  name: string,
  cwd: string,
  cmd: string,
  args: string[],
  expect?: (out: string) => string | null,
) {
  const t0 = Date.now();
  const r = run(cwd, cmd, args);
  const wrong = r.code === 0 ? (expect?.(r.out) ?? null) : `exit ${r.code}`;
  const s = {
    name,
    ok: wrong === null,
    detail: wrong ? `${wrong}\n${tail(r.out)}` : `${((Date.now() - t0) / 1000).toFixed(1)}s`,
  };
  steps.push(s);
  console.log(`  ${s.ok ? "ok  " : "FAIL"}  ${name.padEnd(46)} ${s.detail.split("\n")[0]}`);
  if (!s.ok) for (const l of s.detail.split("\n").slice(1)) console.log(`        | ${l}`);
  return r;
}
const has =
  (...needles: (string | RegExp)[]) =>
  (out: string) => {
    const miss = needles.filter((n) => (typeof n === "string" ? !out.includes(n) : !n.test(out)));
    return miss.length ? `missing in the output: ${miss.join(", ")}` : null;
  };
const gitIn = (dir: string, ...args: string[]) =>
  run(dir, "git", ["-c", "commit.gpgsign=false", ...args]);

/** A committed copy of this working tree: the registry as the next release would be. */
function commitCopy(tag: string, message: string) {
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  for (const f of listSourceFiles(REPO)) cpSync(join(REPO, f), join(src, f));
  gitIn(src, "init", "-q", "-b", "main");
  gitIn(src, "add", ".");
  gitIn(src, "commit", "-q", "--no-verify", "-m", message);
  gitIn(src, "tag", tag);
}

console.log(`registry:check in ${work}`);
commitCopy("v0.1.0", "the registry under test");
const repo = `file://${src}`;

// 1. Invocation.
step("npx <dir> --version", work, "npx", ["-y", REPO, "--version"], has(/\d+\.\d+\.\d+/));
step(
  "pnpm dlx file:<dir> list",
  work,
  "pnpm",
  ["dlx", `file:${REPO}`, "list"],
  has("journeys", "app-tanstack-workers"),
);
step(
  "pnpm dlx git+file://<copy>#v0.1.0 list",
  work,
  "pnpm",
  ["dlx", `git+${repo}#v0.1.0`, "list"],
  has("journeys", "base"),
);

// 2. init, through dlx from git, then the checks.
step(
  "dlx … init proj --repo <copy> --ref v0.1.0",
  work,
  "pnpm",
  ["dlx", `git+${repo}#v0.1.0`, "init", "proj", "--repo", repo, "--ref", "v0.1.0"],
  has("commit        the initial commit"),
);
const checks = (when: string) => {
  step(`${when}: pnpm test`, proj, "pnpm", ["test"], has(/Tests\s+\d+ passed/));
  step(`${when}: pnpm exec tsc --noEmit`, proj, "pnpm", [
    "exec",
    "tsc",
    "--noEmit",
    "-p",
    "tsconfig.json",
  ]);
  step(`${when}: pnpm lint`, proj, "pnpm", ["lint"]);
  step(`${when}: pnpm plan:check`, proj, "pnpm", ["plan:check"]);
};
checks("base");
const commit = (when: string, file: string) => {
  appendFileSync(join(proj, file), `\n<!-- ${when} -->\n`);
  gitIn(proj, "add", "-A");
  step(`${when}: git commit through the hooks`, proj, "git", [
    "commit",
    "-q",
    "-m",
    `${when}\n\nNo-Item: registry check, before any plan item exists`,
  ]);
  const hooks = run(proj, "git", ["config", "core.hooksPath"]).out.trim();
  steps.push({
    name: `${when}: hooks installed`,
    ok: hooks === ".husky/_",
    detail: hooks || "none",
  });
  console.log(
    `  ${hooks === ".husky/_" ? "ok  " : "FAIL"}  ${`${when}: hooks installed`.padEnd(46)} core.hooksPath=${hooks || "unset"}`,
  );
};
commit("base", "docs/progress/README.md");

// 3. Every optional module.
const reg = loadRegistry(REPO);
const modules = Object.entries(reg.items)
  .filter(([, i]) => i.kind === "module")
  .map(([n]) => n);
step(
  `pnpm sdlc add ${modules.join(" ")}`,
  proj,
  "pnpm",
  ["sdlc", "add", ...modules],
  has(...modules),
);
// CI=1 makes pnpm freeze the lockfile; a person running add is not in CI.
step("pnpm install (modules)", proj, "pnpm", ["install", "--no-frozen-lockfile"]);
checks("modules");
commit("modules", "docs/progress/README.md");

// 4. diff and update: one file changed here, one upstream, one on both sides.
const LOCAL = "tooling/core/src/exec.mts";
const UPSTREAM = "tooling/core/src/ports.mts";
const BOTH = "tooling/core/src/git-command.mts";
appendFileSync(join(proj, LOCAL), "// changed in the project\n");
appendFileSync(join(proj, BOTH), "// changed in the project\n");
appendFileSync(join(src, UPSTREAM), "// changed upstream\n");
appendFileSync(join(src, BOTH), "// changed upstream\n");
gitIn(src, "commit", "-q", "--no-verify", "-am", "upstream fix");
gitIn(src, "tag", "v0.1.1");
step(
  "pnpm sdlc diff base --ref v0.1.1",
  proj,
  "pnpm",
  ["sdlc", "diff", "base", "--ref", "v0.1.1"],
  has(
    new RegExp(`changed-upstream\\s+${UPSTREAM}`),
    new RegExp(`locally-modified\\s+${LOCAL}`),
    new RegExp(`both-changed\\s+${BOTH}`),
    "+// changed upstream",
  ),
);
step(
  "pnpm sdlc update base --ref v0.1.1",
  proj,
  "pnpm",
  ["sdlc", "update", "base", "--ref", "v0.1.1"],
  has(`updated   ${UPSTREAM}`, "1 file(s) changed both here and upstream"),
);
const after = (f: string) => readFileSync(join(proj, f), "utf8");
const kept = [
  [UPSTREAM, after(UPSTREAM).endsWith("// changed upstream\n"), "took the upstream change"],
  [LOCAL, after(LOCAL).endsWith("// changed in the project\n"), "kept the project's edit"],
  [
    BOTH,
    after(BOTH).endsWith("// changed in the project\n") && !after(BOTH).includes("upstream"),
    "left for a hand merge",
  ],
] as const;
for (const [f, ok, what] of kept) {
  steps.push({ name: `after update: ${f}`, ok, detail: what });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${`after update: ${f}`.padEnd(46)} ${what}`);
}
step(
  "after update: the sdlc script follows the ref",
  proj,
  "node",
  ["-p", "require('./package.json').scripts.sdlc"],
  has("#v0.1.1"),
);
step("after update: pnpm test", proj, "pnpm", ["test"], has(/Tests\s+\d+ passed/));

const failed = steps.filter((s) => !s.ok);
console.log(
  failed.length
    ? `  ${failed.length} of ${steps.length} step(s) failed`
    : `  all ${steps.length} steps ok`,
);
console.log(keep ? `  kept ${work}` : "  removed the directory (--keep leaves it)");
if (!keep) rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
