/**
 * `pnpm security:scan [--only <check>[,<check>]] [--staged]`
 *
 * One line per check — pass, fail or could-not-run — with findings indented
 * beneath. Exit 0 when every check passed, 1 when any failed, 2 when none
 * failed but at least one could not run (a held verdict, not a pass).
 *
 *   secrets          built-in patterns over tracked files (+ gitleaks/trufflehog)
 *   deps             pnpm audit --json, failing at deps.failAt (default high)
 *   licenses         installed packages against the license allow-list
 *   install-scripts  every install-time script against onlyBuiltDependencies
 *   release-age      pnpm minimumReleaseAge is declared and read
 *
 * `--staged` scans the staged diff instead of every tracked file. It applies to
 * `secrets` only, so it implies `--only secrets`; combining it with another
 * check is a usage error.
 *
 * Optional configuration: `security.config.json` at the repository root
 * (tooling/security/README.md).
 */
import { exec as realExec, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { findRoot } from "../../core/src/config.mts";
import { loadSecurityConfig, SECURITY_CONFIG_FILE } from "./config.mts";
import { checkDeps } from "./deps.mts";
import { checkInstallScripts, readBuildPolicy } from "./install-scripts.mts";
import { checkLicenses } from "./licenses.mts";
import { listInstalled } from "./packages.mts";
import type { InstalledPackage } from "./packages.mts";
import { checkReleaseAge } from "./release-age.mts";
import { checkSecrets } from "./secrets.mts";
import { CHECKS, exitCode } from "./types.mts";
import type { CheckName, CheckResult } from "./types.mts";

export interface ScanArgs {
  only: CheckName[];
  staged: boolean;
}

export function parseArgs(argv: string[]): ScanArgs | { error: string } {
  let only: CheckName[] | null = null;
  let staged = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--staged") staged = true;
    else if (a === "--only" || a.startsWith("--only=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (!v) return { error: "--only needs a check name" };
      const names = v.split(",").map((s) => s.trim());
      const bad = names.filter((n) => !CHECKS.includes(n as CheckName));
      if (bad.length)
        return { error: `unknown check ${bad.join(", ")}; one of ${CHECKS.join(", ")}` };
      only = names as CheckName[];
    } else return { error: `unknown argument ${a}` };
  }
  if (staged) {
    if (only && only.some((n) => n !== "secrets"))
      return { error: "--staged applies to secrets only" };
    only = ["secrets"];
  }
  return { only: only ?? CHECKS, staged };
}

export interface ScanDeps {
  exec: Exec;
  root: string;
  log: (line: string) => void;
}

export function formatResult(r: CheckResult): string[] {
  const head = `${r.name.padEnd(16)}${r.state.padEnd(15)}${r.detail}`;
  return [head, ...r.lines.map((l) => `    ${l}`)];
}

export async function runScan(args: ScanArgs, deps: ScanDeps): Promise<0 | 1 | 2> {
  const { exec, root, log } = deps;
  const loaded = loadSecurityConfig(root);
  if (!loaded.ok) {
    log(`${"config".padEnd(16)}${"fail".padEnd(15)}${SECURITY_CONFIG_FILE} is invalid`);
    for (const p of loaded.problems) log(`    ${p}`);
    return 1;
  }
  const config = loaded.config;
  log(
    `security:scan (${loaded.source === "defaults" ? "default configuration" : SECURITY_CONFIG_FILE})`,
  );

  let installed: InstalledPackage[] | null | undefined;
  const pkgs = () => (installed === undefined ? (installed = listInstalled(root)) : installed);

  const results: CheckResult[] = [];
  for (const name of args.only) {
    let r: CheckResult;
    switch (name) {
      case "secrets":
        r = await checkSecrets({ root, exec, config, staged: args.staged });
        break;
      case "deps":
        r = await checkDeps(exec, root, config);
        break;
      case "licenses":
        r = checkLicenses(pkgs(), config);
        break;
      case "install-scripts":
        r = checkInstallScripts(pkgs(), readBuildPolicy(root));
        break;
      case "release-age":
        r = await checkReleaseAge(exec, root, config);
        break;
    }
    results.push(r);
    for (const line of formatResult(r)) log(line);
  }
  const code = exitCode(results);
  log(
    code === 0 ? "pass" : code === 1 ? "fail" : "could not run — the verdict is held, not passed",
  );
  return code;
}

if (isEntry(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`security:scan: ${args.error}`);
    process.exit(2);
  }
  const root = findRoot() ?? process.cwd();
  const code = await runScan(args, { exec: realExec, root, log: (l) => console.log(l) });
  process.exit(code);
}
