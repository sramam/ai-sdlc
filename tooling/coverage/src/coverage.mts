/**
 * `coverage [--report] [--only <path>] [--unit-only] [--force]`
 *
 * One gate over a merged run. The unit suite runs with @vitest/coverage-v8;
 * when the project declares `vitest.integration.config.*` that suite runs too,
 * and the two istanbul JSON outputs are summed (coverage-lib.mts). A module
 * exercised only through a real client otherwise reads as barely tested, and
 * chasing that number means mocking what is already covered for real.
 *
 *   (no flags)     both suites, merged, floors from sdlc.config.json applied
 *   --report       also rewrites docs/quality/coverage.md between the markers,
 *                  from this same run
 *   --only <path>  runs only the tests under <path> and prints its files,
 *                  weakest first. Undercounts by construction, so it reports
 *                  and never judges, and may not publish
 *   --unit-only    the integration suite cannot run here (no database, say).
 *                  Its coverage is unknown, not zero: reported, not judged, and
 *                  refused from overwriting a merged report without --force
 *   --force        run even when the tree is unchanged since the last green run
 *
 * Floors (`coverage.floors`: path prefix → { lines, branches }) are declared in
 * sdlc.config.json and nowhere else; with none declared the gate prints n/a.
 *
 * A green full run stamps `.ci-local/coverage-<fingerprint>`, a content hash of
 * every source file, the vitest configs, the lockfile, sdlc.config.json and
 * this module; an unchanged tree then skips. Only a green run stamps, so a red
 * build is never skipped past.
 *
 * Exit 0 pass (or reported, not judged), 1 fail (a suite failed or a floor was
 * missed), 2 could not run (vitest or the coverage provider unavailable, no
 * coverage written, or a unit-only report refused over a merged one).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec as realExec, firstLine, isEntry } from "../../core/src/exec.mts";
import type { Exec, ExecResult } from "../../core/src/exec.mts";
import { findRoot, loadConfigSync } from "../../core/src/config.mts";
import {
  applyFloors,
  fingerprint,
  merge,
  MERGED_MARKER,
  relPath,
  renderReport,
  replaceBlock,
  REPORT_PATH,
  stamp,
  stampedFingerprint,
  subset,
  summarise,
  underPrefix,
} from "./coverage-lib.mts";
import type { CoverageJson, Floors, Summary } from "./coverage-lib.mts";

export const USAGE =
  "usage: coverage [--report] [--only <path>] [--unit-only] [--force]\n" +
  "  exit 0 pass · 1 fail · 2 could not run";

export interface CoverageOptions {
  report: boolean;
  only?: string;
  unitOnly: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): CoverageOptions | { error: string } {
  const opts: CoverageOptions = { report: false, unitOnly: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") opts.report = true;
    else if (a === "--unit-only") opts.unitOnly = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `--only needs a path\n${USAGE}` };
      opts.only = v;
    } else if (a?.startsWith("--only=")) opts.only = a.slice("--only=".length);
    else return { error: `unknown argument: ${a}\n${USAGE}` };
  }
  if (opts.report && opts.only)
    return {
      error:
        "--report and --only are exclusive: a filtered run undercounts, and an undercount\n" +
        "must not be published as the repository's figure.",
    };
  return opts;
}

export interface CoverageDeps {
  root: string;
  floors: Floors;
  exec: Exec;
  /** The vitest command prefix. Default `pnpm exec vitest`. */
  vitest: string[];
  /**
   * How vitest finds the provider. Default `--coverage.provider=v8`; see
   * `providerArgs` for the fallback when the project root cannot resolve it.
   */
  provider?: string[];
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** This module's own sources, part of the fingerprint. */
  selfFiles: string[];
  timeoutMs: number;
}

export type Mode = "merged" | "unit" | "unit-only" | "only";

export interface CoverageOutcome {
  exit: 0 | 1 | 2;
  state: "pass" | "fail" | "could-not-run" | "reported" | "skipped";
  fingerprint?: string;
}

const INTEGRATION_CONFIG = /^vitest\.integration\.config\.(ts|mts|cts|js|mjs|cjs)$/;

export function integrationConfig(root: string): string | null {
  return readdirSync(root).find((f) => INTEGRATION_CONFIG.test(f)) ?? null;
}

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build"]);
/** Output and prose at the root only: `tooling/coverage/` is source. */
const SKIP_ROOT_DIRS = new Set(["coverage", "docs"]);

/** Every file a coverage figure can depend on. Errs wide: a false miss costs a run. */
export function fingerprintInputs(root: string, selfFiles: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // Dot directories hold other agents' worktrees, caches and hooks.
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        if (dir === root && SKIP_ROOT_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && SOURCE.test(e.name)) out.push(join(dir, e.name));
    }
  };
  walk(root);
  for (const extra of ["pnpm-lock.yaml", "sdlc.config.json", "package.json"]) {
    if (existsSync(join(root, extra))) out.push(join(root, extra));
  }
  return [...out, ...selfFiles.filter((f) => existsSync(f))];
}

/** The nearest directory holding a package.json, relative to root ("." for the root). */
export function moduleResolver(root: string): (rel: string) => string {
  const cache = new Map<string, string>();
  const find = (relDir: string): string => {
    const hit = cache.get(relDir);
    if (hit !== undefined) return hit;
    let answer: string;
    if (relDir === "" || relDir === ".") answer = ".";
    else if (existsSync(join(root, relDir, "package.json"))) answer = relDir;
    else answer = find(relDir.includes("/") ? relDir.slice(0, relDir.lastIndexOf("/")) : "");
    cache.set(relDir, answer);
    return answer;
  };
  return (rel) => find(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
}

const fmt = (s: Summary) =>
  `${s.lines.toFixed(2)}% lines · ${s.branches.toFixed(2)}% branches · ${s.functions.toFixed(2)}% funcs ` +
  `(${s.counts.lines[0]}/${s.counts.lines[1]} lines)`;

type SuiteRun = { ok: true; json: CoverageJson } | { ok: false; exit: 1 | 2; why: string };

/** Classify a vitest run: a red suite fails the gate; a missing tool could not run. */
export function classifyRun(r: ExecResult, jsonPath: string): SuiteRun {
  const said = `${r.stdout}\n${r.stderr}`;
  if (r.notFound) return { ok: false, exit: 2, why: "vitest could not be started (not found)" };
  if (r.timedOut) return { ok: false, exit: 2, why: "vitest timed out" };
  if (/coverage-v8/.test(said) && /(cannot find|missing|not installed|failed to load)/i.test(said))
    return {
      ok: false,
      exit: 2,
      why: "@vitest/coverage-v8 is not installed where vitest can load it",
    };
  if (r.code !== 0) return { ok: false, exit: 1, why: `the suite failed (exit ${r.code})` };
  if (!existsSync(jsonPath))
    return { ok: false, exit: 2, why: `vitest passed but wrote no ${jsonPath}` };
  try {
    return { ok: true, json: JSON.parse(readFileSync(jsonPath, "utf8")) as CoverageJson };
  } catch (e) {
    return { ok: false, exit: 2, why: `unreadable coverage JSON: ${(e as Error).message}` };
  }
}

function tail(text: string, n = 40): string {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

async function gitStamp(deps: CoverageDeps): Promise<{ sha: string; branch: string }> {
  const ask = async (args: string[]) => {
    const r = await deps.exec("git", args, { cwd: deps.root, timeoutMs: 10_000 });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "unknown";
  };
  return {
    sha: await ask(["rev-parse", "--short", "HEAD"]),
    branch: await ask(["rev-parse", "--abbrev-ref", "HEAD"]),
  };
}

const CACHE_DIR = ".ci-local";
const cacheFile = (fp: string) => `coverage-${fp}`;

export async function runCoverage(
  opts: CoverageOptions,
  deps: CoverageDeps,
): Promise<CoverageOutcome> {
  const { root, log } = deps;
  const integration = integrationConfig(root);
  const mode: Mode = opts.only
    ? "only"
    : integration && opts.unitOnly
      ? "unit-only"
      : integration
        ? "merged"
        : "unit";
  const judged = mode === "merged" || mode === "unit";
  if (opts.unitOnly && !integration)
    log(
      "[ info ] --unit-only, but no vitest.integration.config.* exists: the unit run is the whole run",
    );

  // ── skip an unchanged tree ──
  let fp: string | undefined;
  if (judged) {
    fp = fingerprint(root, fingerprintInputs(root, deps.selfFiles), mode);
    const reportPath = join(root, REPORT_PATH);
    const reportCurrent =
      !opts.report ||
      stampedFingerprint(existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null) === fp;
    if (!opts.force && existsSync(join(root, CACHE_DIR, cacheFile(fp))) && reportCurrent) {
      log(`[  ok  ] unchanged      fingerprint ${fp} passed before: suites not run`);
      log(
        "         Nothing a figure depends on has changed since the last green run. --force runs them anyway.",
      );
      return { exit: 0, state: "skipped", fingerprint: fp };
    }
  }

  // ── run the suites ──
  const dir = mkdtempSync(join(tmpdir(), "ai-sdlc-cov-"));
  try {
    const suite = async (label: string, extra: string[]): Promise<SuiteRun> => {
      const out = join(dir, label);
      const [cmd, ...pre] = deps.vitest;
      const r = await deps.exec(
        cmd!,
        [
          ...pre,
          "run",
          ...extra,
          "--coverage.enabled",
          ...(deps.provider ?? ["--coverage.provider=v8"]),
          "--coverage.reporter=json",
          `--coverage.reportsDirectory=${out}`,
          ...(opts.only ? [opts.only] : []),
        ],
        { cwd: root, env: deps.env, timeoutMs: deps.timeoutMs },
      );
      const run = classifyRun(r, join(out, "coverage-final.json"));
      if (run.ok) log(`[  ok  ] ${label} suite`);
      else {
        log(`[ ${run.exit === 1 ? "FAIL" : " ?? "} ] ${label} suite: ${run.why}`);
        const said = tail(`${r.stdout}\n${r.stderr}`);
        if (said) log(said);
      }
      return run;
    };

    const unit = await suite("unit", []);
    if (!unit.ok) return { exit: unit.exit, state: unit.exit === 1 ? "fail" : "could-not-run" };
    let merged = unit.json;
    if (integration && mode !== "unit-only") {
      const integ = await suite("integration", ["--config", integration]);
      if (!integ.ok)
        return { exit: integ.exit, state: integ.exit === 1 ? "fail" : "could-not-run" };
      merged = merge(merged, integ.json);
    }
    // Absolute paths outside the root (a linked package) are not this project's figure.
    merged = subset(merged, root, (rel) => !rel.startsWith("../") && !rel.startsWith("/"));

    log("");
    log(
      `[  ok  ] ${mode === "merged" ? "merged total  " : "unit total    "} ${fmt(summarise(merged))}`,
    );

    if (mode === "only") {
      const rows = Object.keys(merged)
        .map((abs) => ({ rel: relPath(root, abs), s: summarise({ [abs]: merged[abs]! }) }))
        .filter((r) => underPrefix(r.rel, opts.only!))
        .sort((a, b) => a.s.lines - b.s.lines || a.s.branches - b.s.branches);
      log(`         ${opts.only}: weakest first`);
      for (const r of rows)
        log(
          `         ${r.s.lines.toFixed(0).padStart(3)}% lines ${r.s.branches.toFixed(0).padStart(3)}% br  ${r.rel}`,
        );
      log(
        "[ warn ] --only ran a subset of the tests, so this undercounts code other tests exercise.",
      );
      log("         Reported, not judged. Run without --only for the figure that counts.");
      return { exit: 0, state: "reported" };
    }

    // ── the published figure, written before the gate so a red run still shows it ──
    const reportPath = join(root, REPORT_PATH);
    if (opts.report) {
      const existing = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
      if (mode === "unit-only" && !opts.force && existing?.includes(MERGED_MARKER)) {
        log(`[  ??  ] refusing to overwrite a merged ${REPORT_PATH} with a unit-only one.`);
        log(
          "         The integration suite did not run, so its coverage is unknown here, not zero;",
        );
        log(
          "         publishing it reports a collapse that did not happen. Run both suites, or --force.",
        );
        return { exit: 2, state: "could-not-run" };
      }
      const suites =
        mode === "merged"
          ? MERGED_MARKER
          : mode === "unit"
            ? "the unit suite (no `vitest.integration.config.*` is declared, so it is the whole run)"
            : "**the unit suite only** (`--unit-only`): the integration suite did not run, so its coverage is unknown here, not zero";
      const block = renderReport({
        merged,
        root,
        floors: deps.floors,
        suites,
        judged,
        moduleOf: moduleResolver(root),
        at: await gitStamp(deps),
      });
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, replaceBlock(existing, block));
      log(`[  ok  ] wrote          ${REPORT_PATH}`);
    }

    if (!judged) {
      for (const r of applyFloors(merged, root, deps.floors))
        log(`[ info ] ${(r.prefix || ".").padEnd(14)} unit run only: ${fmt(r.measured)}`);
      log("         Reported, not judged: the integration suite did not run here, so code only it");
      log("         reaches reads as uncovered. The run with both suites is the gate.");
      return { exit: 0, state: "reported" };
    }

    // ── the gate ──
    const results = applyFloors(merged, root, deps.floors);
    if (results.length === 0)
      log("[ n/a  ] floors         none declared in sdlc.config.json (coverage.floors is empty)");
    let failed = false;
    for (const r of results) {
      const name = (r.prefix || ".").padEnd(14);
      if (r.state === "pass")
        log(`[  ok  ] ${name} floor lines ≥ ${r.floor.lines} · branches ≥ ${r.floor.branches}`);
      else if (r.state === "empty") {
        failed = true;
        log(`[ FAIL ] ${name} matches no covered file: a misspelled prefix, or code that moved`);
      } else {
        failed = true;
        log(`[ FAIL ] ${name} is below its floor:`);
        for (const s of r.shortfalls) log(`         ${s}`);
      }
    }
    if (failed) {
      log(
        "         Cover it rather than lowering the floor. If a floor must fall, write why in the",
      );
      log("         commit that changes sdlc.config.json.");
      return { exit: 1, state: "fail", fingerprint: fp };
    }

    // Green: stamp the report and remember the pass. Never before the gate.
    if (opts.report && existsSync(reportPath))
      writeFileSync(reportPath, stamp(readFileSync(reportPath, "utf8"), fp!));
    const cacheDir = join(root, CACHE_DIR);
    mkdirSync(cacheDir, { recursive: true });
    for (const f of readdirSync(cacheDir))
      if (/^coverage-[0-9a-f]{16}$/.test(f)) rmSync(join(cacheDir, f), { force: true });
    writeFileSync(join(cacheDir, cacheFile(fp!)), `${JSON.stringify(summarise(merged).counts)}\n`);
    return { exit: 0, state: "pass", fingerprint: fp };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * vitest resolves `@vitest/coverage-v8` from the **project root**, not from
 * this package: with pnpm's strict layout a dependency declared only here is
 * invisible to it ("Cannot find package '@vitest/coverage-v8'", measured).
 * When the root cannot see it, hand vitest this package's copy as a custom
 * provider module — the same v8 provider, located explicitly. Declaring it in
 * the root devDependencies is still the better answer, and the run says so.
 */
export function providerArgs(root: string, ours: string | null): { args: string[]; note?: string } {
  if (existsSync(join(root, "node_modules", "@vitest", "coverage-v8")) || !ours)
    return { args: ["--coverage.provider=v8"] };
  return {
    args: ["--coverage.provider=custom", `--coverage.customProviderModule=${ours}`],
    note: "[ info ] @vitest/coverage-v8 is not a root devDependency; using @ai-sdlc/coverage's copy",
  };
}

function ownProvider(): string | null {
  try {
    return fileURLToPath(import.meta.resolve("@vitest/coverage-v8"));
  } catch {
    return null;
  }
}

const SELF_FILES = ["coverage.mts", "coverage-lib.mts"].map((f) =>
  fileURLToPath(new URL(`./${f}`, import.meta.url)),
);

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if ("error" in opts) {
    console.error(opts.error);
    process.exit(2);
  }
  const root = findRoot();
  if (!root) {
    console.error("coverage: no sdlc.config.json above this directory");
    process.exit(2);
  }
  let floors: Floors;
  try {
    floors = loadConfigSync(root).coverage.floors;
  } catch (e) {
    console.error(`coverage: ${firstLine((e as Error).message, 200)}`);
    process.exit(2);
  }
  const provider = providerArgs(root, ownProvider());
  if (provider.note) console.log(provider.note);
  const outcome = await runCoverage(opts, {
    provider: provider.args,
    root,
    floors,
    exec: realExec,
    vitest: ["pnpm", "exec", "vitest"],
    env: process.env,
    log: (l) => console.log(l),
    selfFiles: SELF_FILES,
    timeoutMs: 30 * 60_000,
  });
  process.exit(outcome.exit);
}

if (isEntry(import.meta.url)) await main();
