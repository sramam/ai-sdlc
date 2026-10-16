/**
 * The install-script pattern check. Every installed package that would run code at
 * install time is named, and the policy is read from pnpm's own settings:
 *
 * - `onlyBuiltDependencies` in pnpm-workspace.yaml (or root package.json
 *   `pnpm.onlyBuiltDependencies`) is the allow-list. Everything unlisted is
 *   **denied** by pnpm, and the pattern check reports it as denied.
 * - A listed package that is no longer installed, or no longer has a script,
 *   **fails**: the list may only shrink, and an entry outliving its reason is
 *   a standing grant nobody is reviewing.
 * - A policy that lets an unlisted package run fails: `dangerouslyAllowAllBuilds`,
 *   a `neverBuiltDependencies` deny-list (everything else allowed), or no
 *   allow-list at all (the answer then depends on the pnpm version).
 *
 * A `binding.gyp` with no install script counts: npm and pnpm run
 * `node-gyp rebuild` for it implicitly.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstalledPackage } from "./packages.mts";
import { result } from "./types.mts";
import type { CheckResult } from "./types.mts";
import { asList, parseTopLevelYaml } from "./workspace-yaml.mts";
import type { YamlValue } from "./workspace-yaml.mts";

const HOOKS = ["preinstall", "install", "postinstall"] as const;

/** Which install-time hooks a package declares, implicit node-gyp included. */
export function installHooks(p: InstalledPackage): string[] {
  const scripts = (p.pkg.scripts ?? {}) as Record<string, unknown>;
  const hooks: string[] = HOOKS.filter((h) => typeof scripts[h] === "string" && scripts[h] !== "");
  if (!scripts.install && !scripts.preinstall && existsSync(join(p.dir, "binding.gyp")))
    hooks.push("install (implicit node-gyp)");
  return hooks;
}

export interface BuildPolicy {
  /** null: not declared anywhere. */
  only: string[] | null;
  dangerouslyAllowAll: boolean;
  never: string[] | null;
  /** Declared in a form this pattern check cannot read. */
  unreadable: string[];
}

export function readBuildPolicy(root: string): BuildPolicy {
  const policy: BuildPolicy = {
    only: null,
    dangerouslyAllowAll: false,
    never: null,
    unreadable: [],
  };
  const ws = join(root, "pnpm-workspace.yaml");
  const y = existsSync(ws)
    ? parseTopLevelYaml(readFileSync(ws, "utf8"))
    : new Map<string, YamlValue>();
  let pj: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pj = (pkg.pnpm ?? {}) as Record<string, unknown>;
  } catch {
    // No package.json pnpm block: the workspace file decides alone.
  }
  const listOf = (key: string): string[] | null => {
    const fromYaml = y.get(key);
    if (fromYaml !== undefined) {
      const l = asList(fromYaml);
      if (l === null) policy.unreadable.push(`pnpm-workspace.yaml ${key}`);
      return l ?? [];
    }
    const fromPj = pj[key];
    if (fromPj === undefined) return null;
    return Array.isArray(fromPj) ? fromPj.filter((x): x is string => typeof x === "string") : [];
  };
  policy.only = listOf("onlyBuiltDependencies");
  policy.never = listOf("neverBuiltDependencies");
  policy.dangerouslyAllowAll =
    y.get("dangerouslyAllowAllBuilds") === true || pj.dangerouslyAllowAllBuilds === true;
  if (y.has("onlyBuiltDependenciesFile") || pj.onlyBuiltDependenciesFile !== undefined)
    policy.unreadable.push("onlyBuiltDependenciesFile");
  return policy;
}

export function checkInstallScripts(
  installed: InstalledPackage[] | null,
  policy: BuildPolicy,
): CheckResult {
  if (installed === null)
    return result(
      "install-scripts",
      "could-not-run",
      "no node_modules/.pnpm — run pnpm install first",
    );
  if (policy.unreadable.length > 0)
    return result(
      "install-scripts",
      "could-not-run",
      `policy declared in a form this pattern check cannot read: ${policy.unreadable.join(", ")}`,
    );

  const withScripts = installed
    .map((p) => ({ p, hooks: installHooks(p) }))
    .filter((x) => x.hooks.length > 0);
  const only = new Set(policy.only ?? []);
  const lines: string[] = [];
  const problems: string[] = [];

  if (policy.dangerouslyAllowAll)
    problems.push("dangerouslyAllowAllBuilds is true: every install script runs");
  if (policy.never !== null)
    problems.push("neverBuiltDependencies is a deny-list: every unlisted package's scripts run");
  if (policy.only === null)
    problems.push(
      "no onlyBuiltDependencies declared — add `onlyBuiltDependencies: []` to pnpm-workspace.yaml so denial does not depend on the pnpm version",
    );

  for (const { p, hooks } of withScripts) {
    const allowed = only.has(p.name);
    const unlistedRuns = !allowed && (policy.dangerouslyAllowAll || policy.never !== null);
    lines.push(
      `${allowed || unlistedRuns ? "allowed" : "denied "}  ${p.name}@${p.version}  ${hooks.join(", ")}`,
    );
  }
  const scripted = new Set(withScripts.map((x) => x.p.name));
  const installedNames = new Set(installed.map((p) => p.name));
  for (const name of only) {
    if (!installedNames.has(name))
      problems.push(`onlyBuiltDependencies lists ${name}, which is not installed — remove it`);
    else if (!scripted.has(name))
      problems.push(
        `onlyBuiltDependencies lists ${name}, which no longer has an install script — remove it`,
      );
  }

  const allowedCount = withScripts.filter((x) => only.has(x.p.name)).length;
  const summary = `${withScripts.length} package(s) with install scripts: ${allowedCount} allowed, ${withScripts.length - allowedCount} denied`;
  return result("install-scripts", problems.length > 0 ? "fail" : "pass", summary, [
    ...problems,
    ...lines,
  ]);
}
