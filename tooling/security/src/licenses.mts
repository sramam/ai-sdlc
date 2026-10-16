/**
 * Licenses of every installed package against an allow-list.
 *
 * The declared `license` is read as an SPDX expression: `OR` takes the best
 * alternative, `AND` the worst, `WITH <exception>` is judged by its license. A
 * package declaring nothing, or something that is not an expression we can
 * read (`SEE LICENSE IN …`), fails: an unknown license is not a permissive one.
 * An exception names the package and says why, and an exception that no longer
 * excuses anything fails, so the list only shrinks.
 */
import type { SecurityConfig } from "./config.mts";
import type { InstalledPackage } from "./packages.mts";
import { result } from "./types.mts";
import type { CheckResult } from "./types.mts";

export type LicenseVerdict = "allow" | "warn" | "deny";

const RANK: Record<LicenseVerdict, number> = { allow: 0, warn: 1, deny: 2 };

export function declaredLicense(pkg: Record<string, unknown>): string | null {
  const l = pkg.license;
  if (typeof l === "string" && l.trim()) return l.trim();
  if (l && typeof l === "object" && typeof (l as { type?: unknown }).type === "string")
    return (l as { type: string }).type;
  const ls = pkg.licenses;
  if (Array.isArray(ls)) {
    const types = ls
      .map((x) => (typeof x === "string" ? x : (x as { type?: unknown })?.type))
      .filter((t): t is string => typeof t === "string");
    if (types.length) return types.length === 1 ? (types[0] as string) : `(${types.join(" OR ")})`;
  }
  return null;
}

/** Evaluate an SPDX expression; `null` when it cannot be parsed. */
export function evaluateLicense(
  expr: string,
  allow: string[],
  warn: string[],
): LicenseVerdict | null {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const A = lower(allow);
  const W = lower(warn);
  const leaf = (id: string): LicenseVerdict => {
    const k = id.replace(/\+$/, "").toLowerCase();
    return A.has(k) ? "allow" : W.has(k) ? "warn" : "deny";
  };
  const worst = (a: LicenseVerdict, b: LicenseVerdict) => (RANK[a] >= RANK[b] ? a : b);
  const best = (a: LicenseVerdict, b: LicenseVerdict) => (RANK[a] <= RANK[b] ? a : b);

  function factor(): LicenseVerdict | null {
    const t = tokens[i];
    if (t === undefined) return null;
    if (t === "(") {
      i++;
      const v = orExpr();
      if (tokens[i] !== ")") return null;
      i++;
      return v;
    }
    if (t === ")" || /^(AND|OR|WITH)$/i.test(t)) return null;
    i++;
    if (tokens[i]?.toUpperCase() === "WITH") i += 2; // the exception modifies, not replaces
    return leaf(t);
  }
  function andExpr(): LicenseVerdict | null {
    let v = factor();
    while (v !== null && tokens[i]?.toUpperCase() === "AND") {
      i++;
      const r = factor();
      v = r === null ? null : worst(v, r);
    }
    return v;
  }
  function orExpr(): LicenseVerdict | null {
    let v = andExpr();
    while (v !== null && tokens[i]?.toUpperCase() === "OR") {
      i++;
      const r = andExpr();
      v = r === null ? null : best(v, r);
    }
    return v;
  }
  const v = orExpr();
  return v !== null && i === tokens.length ? v : null;
}

export function checkLicenses(
  installed: InstalledPackage[] | null,
  config: SecurityConfig,
): CheckResult {
  if (installed === null)
    return result("licenses", "could-not-run", "no node_modules/.pnpm — run pnpm install first");
  const { allow, warn, exceptions } = config.licenses;
  const used = new Set<number>();
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const p of installed) {
    const lic = declaredLicense(p.pkg);
    const verdict = lic === null ? null : evaluateLicense(lic, allow, warn);
    if (verdict === "allow") continue;
    const ex = exceptions.findIndex(
      (e) => e.package === p.name || e.package === `${p.name}@${p.version}`,
    );
    if (ex >= 0) {
      used.add(ex);
      continue;
    }
    const shown = lic ?? "no license declared";
    if (verdict === "warn") warnings.push(`warn  ${p.name}@${p.version}: ${shown}`);
    else
      failures.push(
        `${p.name}@${p.version}: ${shown}${lic !== null && verdict === null ? " (not an SPDX expression we can read)" : ""}`,
      );
  }
  const stale = exceptions
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !used.has(i))
    .map(({ e, i }) => `exception ${i} (${e.package}) excuses nothing installed — remove it`);
  const lines = [...failures, ...stale, ...warnings];
  const summary = `${installed.length} packages; ${failures.length} outside the allow-list, ${warnings.length} warn, ${used.size} excepted`;
  return result("licenses", failures.length + stale.length > 0 ? "fail" : "pass", summary, lines);
}
