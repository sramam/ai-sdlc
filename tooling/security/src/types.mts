/**
 * What every check answers. Three answers, never two (docs/kit/principles.md):
 * a check that could not ask says so, and holds the verdict without failing it.
 */
export type CheckName = "secrets" | "deps" | "licenses" | "install-scripts" | "release-age";

export const CHECKS: CheckName[] = [
  "secrets",
  "deps",
  "licenses",
  "install-scripts",
  "release-age",
];

export type State = "pass" | "fail" | "could-not-run";

export interface CheckResult {
  name: CheckName;
  state: State;
  /** The one line printed beside the state. Never contains a secret value. */
  detail: string;
  /** Indented lines under it: findings, warnings, stale allow-list entries. */
  lines: string[];
}

export function result(
  name: CheckName,
  state: State,
  detail: string,
  lines: string[] = [],
): CheckResult {
  return { name, state, detail, lines };
}

/** Exit code for a set of results: any fail is 1, else any could-not-run is 2, else 0. */
export function exitCode(results: CheckResult[]): 0 | 1 | 2 {
  if (results.some((r) => r.state === "fail")) return 1;
  if (results.some((r) => r.state === "could-not-run")) return 2;
  return 0;
}
