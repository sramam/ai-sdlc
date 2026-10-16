/**
 * A minimum release age, so a version published an hour ago is not installed
 * today: most malicious releases are found and pulled within a day.
 *
 * **The setting is pnpm's `minimumReleaseAge`, in minutes** — added in pnpm
 * 10.16.0; `minimum-release-age` in `.npmrc`. Verified on pnpm 10.28.2 by
 * reading its config definitions and by `pnpm config get minimumReleaseAge`
 * returning a value set in either file. `minimumReleaseAgeExclude` is its
 * escape hatch.
 *
 * Two readers, because they answer different questions:
 * - **the committed files** say whether the project declares it. A value only in
 *   the developer's own `~/.npmrc` protects that one machine and no clone.
 * - **`pnpm config get`** is the reader that will consume it (docs: read a value
 *   from the source that consumes it), so a spelling pnpm ignores fails here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstLine } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import type { SecurityConfig } from "./config.mts";
import { result } from "./types.mts";
import type { CheckResult } from "./types.mts";
import { parseNpmrc, parseTopLevelYaml } from "./workspace-yaml.mts";

export const SINCE = [10, 16, 0] as const;
const LOOKED_FOR = "`minimumReleaseAge` in pnpm-workspace.yaml or `minimum-release-age` in .npmrc";

export function versionAtLeast(v: string, min: readonly number[]): boolean | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if ((parts[i] as number) !== min[i]) return (parts[i] as number) > (min[i] as number);
  }
  return true;
}

/** Where the repository declares it, and the value it declares. */
export function committedReleaseAge(root: string): { file: string; value: string } | null {
  const ws = join(root, "pnpm-workspace.yaml");
  if (existsSync(ws)) {
    const v = parseTopLevelYaml(readFileSync(ws, "utf8")).get("minimumReleaseAge");
    if (v !== undefined) return { file: "pnpm-workspace.yaml", value: String(v) };
  }
  const rc = join(root, ".npmrc");
  if (existsSync(rc)) {
    const m = parseNpmrc(readFileSync(rc, "utf8"));
    const v = m.get("minimum-release-age") ?? m.get("minimumReleaseAge");
    if (v !== undefined) return { file: ".npmrc", value: v };
  }
  return null;
}

export async function checkReleaseAge(
  exec: Exec,
  root: string,
  config: SecurityConfig,
): Promise<CheckResult> {
  const min = config.releaseAge.minMinutes;
  const ver = await exec("pnpm", ["--version"], { cwd: root, timeoutMs: 30_000 });
  if (ver.notFound || ver.code !== 0)
    return result(
      "release-age",
      "could-not-run",
      `cannot ask pnpm (${ver.notFound ? "not installed" : firstLine(ver.stderr) || `exit ${ver.code}`}); looked for ${LOOKED_FOR}`,
    );
  const version = ver.stdout.trim();
  const supported = versionAtLeast(version, SINCE);
  if (supported === null)
    return result(
      "release-age",
      "could-not-run",
      `unreadable pnpm version ${JSON.stringify(firstLine(version))}; looked for ${LOOKED_FOR}`,
    );
  if (!supported)
    return result(
      "release-age",
      "fail",
      `pnpm ${version} predates minimumReleaseAge (${SINCE.join(".")}): the setting would be ignored`,
    );

  const committed = committedReleaseAge(root);
  const got = await exec("pnpm", ["config", "get", "minimumReleaseAge"], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (got.code !== 0)
    return result(
      "release-age",
      "could-not-run",
      `pnpm config get minimumReleaseAge: ${firstLine(got.stderr) || `exit ${got.code}`}`,
    );
  const raw = got.stdout.trim();
  const effective = raw === "" || raw === "undefined" ? null : Number(raw);

  if (committed === null)
    return result(
      "release-age",
      "fail",
      `unset in the repository — add \`minimumReleaseAge: ${min}\` (minutes) to pnpm-workspace.yaml` +
        (effective !== null ? ` (pnpm reads ${raw} from user config, which no clone shares)` : ""),
    );
  if (effective === null || Number.isNaN(effective))
    return result(
      "release-age",
      "fail",
      `${committed.file} declares ${committed.value}, but pnpm ${version} reads no minimumReleaseAge — check the spelling`,
    );
  if (effective < min)
    return result(
      "release-age",
      "fail",
      `minimumReleaseAge is ${effective} min, below the required ${min} (security.config.json releaseAge.minMinutes)`,
    );
  return result(
    "release-age",
    "pass",
    `minimumReleaseAge ${effective} min (${committed.file}; pnpm ${version} reads it)`,
  );
}
