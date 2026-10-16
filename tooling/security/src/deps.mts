/**
 * `pnpm audit --json` over the whole lockfile — every importer, the root
 * included, so the starter's own devDependencies are audited, not only the
 * product's production tree. Fails at or above `deps.failAt` (default high).
 *
 * The audit needs the registry. Anything that is not a readable report — no
 * pnpm, a timeout, an error object, a body that is not JSON — is could-not-run.
 * It is never a pass: an audit that did not happen found nothing only in the
 * sense that it did not look.
 */
import { firstLine } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { SEVERITIES } from "./config.mts";
import type { SecurityConfig, Severity } from "./config.mts";
import { result } from "./types.mts";
import type { CheckResult } from "./types.mts";

interface Advisory {
  id: number;
  github_advisory_id?: string;
  module_name: string;
  severity: string;
  vulnerable_versions?: string;
  patched_versions?: string;
  title?: string;
  findings?: Array<{ version: string; paths: string[] }>;
}

export interface AuditReport {
  advisories?: Record<string, Advisory>;
  error?: { code?: string; summary?: string; message?: string };
}

const rank = (s: string) => SEVERITIES.indexOf(s as Severity);

export function evaluateAudit(report: AuditReport, config: SecurityConfig): CheckResult {
  const advisories = Object.values(report.advisories ?? {});
  const threshold = rank(config.deps.failAt);
  const ids = (a: Advisory) => [String(a.id), a.github_advisory_id].filter(Boolean) as string[];
  const used = new Set<number>();
  const failing: string[] = [];
  const below: Record<string, number> = {};
  for (const a of advisories) {
    const ig = config.deps.ignore.findIndex((e) => ids(a).includes(e.id));
    if (ig >= 0) {
      used.add(ig);
      continue;
    }
    if (rank(a.severity) < threshold) {
      below[a.severity] = (below[a.severity] ?? 0) + 1;
      continue;
    }
    const f = a.findings?.[0];
    const via = f?.paths?.[0] ? ` via ${f.paths[0]}` : "";
    failing.push(
      `${a.severity}  ${a.module_name}@${f?.version ?? "?"}  ${a.github_advisory_id ?? a.id}${via} — fixed in ${a.patched_versions ?? "?"}${a.title ? `: ${a.title}` : ""}`,
    );
  }
  const stale = config.deps.ignore
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !used.has(i))
    .map(({ e, i }) => `ignore entry ${i} (${e.id}) matches no current advisory — remove it`);
  const belowText = Object.entries(below)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  const summary =
    `${failing.length} advisor${failing.length === 1 ? "y" : "ies"} at or above ${config.deps.failAt}` +
    (belowText ? `; below threshold: ${belowText}` : "") +
    (used.size ? `; ${used.size} ignored` : "");
  return result("deps", failing.length + stale.length > 0 ? "fail" : "pass", summary, [
    ...failing,
    ...stale,
  ]);
}

export async function checkDeps(
  exec: Exec,
  root: string,
  config: SecurityConfig,
): Promise<CheckResult> {
  const r = await exec("pnpm", ["audit", "--json"], { cwd: root, timeoutMs: 180_000 });
  if (r.notFound) return result("deps", "could-not-run", "pnpm is not installed");
  if (r.timedOut)
    return result("deps", "could-not-run", "pnpm audit timed out (the registry did not answer)");
  let report: AuditReport;
  try {
    report = JSON.parse(r.stdout) as AuditReport;
  } catch {
    return result(
      "deps",
      "could-not-run",
      `pnpm audit gave no report (exit ${r.code}): ${firstLine(r.stderr || r.stdout) || "no output"}`,
    );
  }
  if (report.error || report.advisories === undefined)
    return result(
      "deps",
      "could-not-run",
      `pnpm audit could not ask the registry: ${firstLine(report.error?.summary ?? report.error?.message ?? report.error?.code ?? "no advisories field in the report")}`,
    );
  return evaluateAudit(report, config);
}
