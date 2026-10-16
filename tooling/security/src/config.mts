/**
 * `security.config.json` at the repository root: optional, with defaults when
 * absent. A separate file from sdlc.config.json so this module needs nothing
 * from core's schema. Validated with core's shape checker, plus the one rule a
 * shape cannot say: **every exception carries a reason of at least three
 * words.** An allow-list entry with no reason cannot be told from one nobody
 * thought about (docs/guardrails.md: relax on evidence, with a reason).
 *
 * Declarative JSON, never executed, for the reason core gives for its own.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../../core/src/shape.mts";
import type { Shape } from "../../core/src/shape.mts";

export const SECURITY_CONFIG_FILE = "security.config.json";

export const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface SecretAllow {
  /** Repository-relative path or glob (`**`, `*`). */
  path: string;
  /** A regex tested against the offending line and against the rule id. */
  pattern: string;
  /** Narrow the entry to one rule id. */
  rule?: string;
  reason: string;
}

export interface SecurityConfig {
  secrets: { allow: SecretAllow[]; exclude: string[] };
  deps: { failAt: Severity; ignore: Array<{ id: string; reason: string }> };
  licenses: {
    allow: string[];
    warn: string[];
    exceptions: Array<{ package: string; reason: string }>;
  };
  releaseAge: { minMinutes: number };
}

/** The permissive set. MPL-2.0 is weak copyleft: allowed, and said out loud. */
export const DEFAULT_LICENSE_ALLOW = [
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  // PSF-2.0 is permissive; argparse (under eslint) carries it in every project.
  "Python-2.0",
];
export const DEFAULT_LICENSE_WARN = ["MPL-2.0"];

export const DEFAULTS: SecurityConfig = {
  secrets: { allow: [], exclude: [] },
  deps: { failAt: "high", ignore: [] },
  licenses: { allow: DEFAULT_LICENSE_ALLOW, warn: DEFAULT_LICENSE_WARN, exceptions: [] },
  // One day, in minutes (pnpm's unit).
  releaseAge: { minMinutes: 1440 },
};

const str: Shape = { t: "string", minLength: 1 };
const strList: Shape = { t: "array", items: str };
const reasoned = (props: Record<string, Shape>, optional: string[] = []): Shape => ({
  t: "object",
  props: Object.fromEntries(
    Object.entries({ ...props, reason: str }).map(([k, s]) => [
      k,
      { shape: s, optional: optional.includes(k) },
    ]),
  ),
});

export const SHAPE: Shape = {
  t: "object",
  props: {
    $schema: { shape: str, optional: true },
    secrets: {
      optional: true,
      shape: {
        t: "object",
        props: {
          allow: {
            optional: true,
            shape: {
              t: "array",
              items: reasoned({ path: str, pattern: str, rule: str }, ["rule"]),
            },
          },
          exclude: { optional: true, shape: strList },
        },
      },
    },
    deps: {
      optional: true,
      shape: {
        t: "object",
        props: {
          failAt: { optional: true, shape: { t: "enum", values: [...SEVERITIES] } },
          ignore: { optional: true, shape: { t: "array", items: reasoned({ id: str }) } },
        },
      },
    },
    licenses: {
      optional: true,
      shape: {
        t: "object",
        props: {
          allow: { optional: true, shape: strList },
          warn: { optional: true, shape: strList },
          exceptions: {
            optional: true,
            shape: { t: "array", items: reasoned({ package: str }) },
          },
        },
      },
    },
    releaseAge: {
      optional: true,
      shape: {
        t: "object",
        props: { minMinutes: { optional: true, shape: { t: "integer", min: 1 } } },
      },
    },
  },
};

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Problems beyond the shape: short reasons, patterns that do not compile. */
function semanticProblems(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const lists: Array<[string, unknown]> = [
    ["secrets.allow", (raw.secrets as Record<string, unknown> | undefined)?.allow],
    ["deps.ignore", (raw.deps as Record<string, unknown> | undefined)?.ignore],
    ["licenses.exceptions", (raw.licenses as Record<string, unknown> | undefined)?.exceptions],
  ];
  for (const [at, list] of lists) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry: Record<string, unknown>, i) => {
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      if (words(reason) < 3)
        out.push(
          `${at}[${i}].reason: needs at least three words saying why, got ${JSON.stringify(reason)}`,
        );
      if (at === "secrets.allow" && typeof entry.pattern === "string") {
        try {
          new RegExp(entry.pattern);
        } catch (e) {
          out.push(`${at}[${i}].pattern: not a valid regex (${(e as Error).message})`);
        }
      }
    });
  }
  return out;
}

export type LoadedConfig =
  | { ok: true; config: SecurityConfig; source: "defaults" | typeof SECURITY_CONFIG_FILE }
  | { ok: false; problems: string[] };

/** Validate parsed JSON and fill defaults. */
export function validateSecurityConfig(raw: unknown): LoadedConfig {
  const problems = check(SHAPE, raw);
  if (problems.length > 0) return { ok: false, problems };
  const r = raw as Record<string, Record<string, unknown> | undefined>;
  const semantic = semanticProblems(r as Record<string, unknown>);
  if (semantic.length > 0) return { ok: false, problems: semantic };
  const pick = <T,>(section: string, key: string, fallback: T): T =>
    (r[section]?.[key] as T | undefined) ?? fallback;
  return {
    ok: true,
    source: SECURITY_CONFIG_FILE,
    config: {
      secrets: {
        allow: pick("secrets", "allow", DEFAULTS.secrets.allow),
        exclude: pick("secrets", "exclude", DEFAULTS.secrets.exclude),
      },
      deps: {
        failAt: pick("deps", "failAt", DEFAULTS.deps.failAt),
        ignore: pick("deps", "ignore", DEFAULTS.deps.ignore),
      },
      licenses: {
        allow: pick("licenses", "allow", DEFAULTS.licenses.allow),
        warn: pick("licenses", "warn", DEFAULTS.licenses.warn),
        exceptions: pick("licenses", "exceptions", DEFAULTS.licenses.exceptions),
      },
      releaseAge: { minMinutes: pick("releaseAge", "minMinutes", DEFAULTS.releaseAge.minMinutes) },
    },
  };
}

export function loadSecurityConfig(root: string): LoadedConfig {
  const file = join(root, SECURITY_CONFIG_FILE);
  if (!existsSync(file)) return { ok: true, config: DEFAULTS, source: "defaults" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return {
      ok: false,
      problems: [`${SECURITY_CONFIG_FILE}: not valid JSON (${(e as Error).message})`],
    };
  }
  return validateSecurityConfig(raw);
}
