/**
 * The secret scan: a built-in, dependency-free scanner over tracked files (or
 * the staged diff), plus gitleaks and/or TruffleHog when installed.
 *
 * - **High signal over coverage.** Each rule is a vendor token shape or a key
 *   block, or a `*_SECRET=` / `*_API_KEY=` assignment whose value is long and
 *   random-looking. A noisy scan is one people learn to allow-list wholesale.
 * - **A finding never carries the value.** Reports name the file, line and rule;
 *   the matched text stays in memory for allow-list matching and is dropped.
 * - **An external engine is a second opinion, not a dependency.** Absent, the
 *   line says so; a crash degrades to built-in only, and says that too.
 * - **The allow-list may only shrink**: on a full scan an entry that matches
 *   nothing fails, so an exception outlives its reason by at most one run.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { firstLine } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import type { SecretAllow, SecurityConfig } from "./config.mts";
import { SECURITY_CONFIG_FILE } from "./config.mts";
import { matchesGlob } from "./glob.mts";
import { result } from "./types.mts";
import type { CheckResult } from "./types.mts";

export interface Rule {
  id: string;
  re: RegExp;
  /** For an assignment rule: which group holds the value to judge. */
  valueGroup?: number;
}

/** Bits per character. A real key sits well above 3.5; a word or a placeholder below. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER =
  /(example|placeholder|changeme|change_me|your[_-]|dummy|redacted|sample|xxxx|\*\*\*|<|>|\$\{|\.\.\.)/i;

/** Does an assignment's value look like a real secret rather than a name or a stand-in? */
export function looksRandom(value: string): boolean {
  if (value.length < 20) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  return entropy(value) >= 3.5;
}

export const RULES: Rule[] = [
  { id: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key-id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  {
    id: "aws-secret-access-key",
    re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i,
  },
  { id: "gcp-api-key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { id: "gcp-service-account", re: /"private_key_id"\s*:\s*"[a-f0-9]{40}"/ },
  {
    id: "cloudflare-api-token",
    re: /\b(?:CLOUDFLARE|CF)_(?:API_TOKEN|API_KEY|GLOBAL_API_KEY)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{37,})/,
    valueGroup: 1,
  },
  { id: "cloudflare-origin-ca-key", re: /\bv1\.0-[a-f0-9]{24}-[a-f0-9]{146}\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  // Anthropic before OpenAI: both begin `sk-`.
  { id: "anthropic-api-key", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/ },
  { id: "openai-api-key", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/ },
  { id: "openai-api-key-legacy", re: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/ },
  { id: "stripe-secret-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/ },
  { id: "stripe-webhook-secret", re: /\bwhsec_[A-Za-z0-9]{32,}\b/ },
  { id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  {
    id: "slack-webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/,
  },
  {
    id: "generic-secret-assignment",
    re: /\b(?:[A-Z][A-Z0-9_]*_)?(?:SECRET|API_KEY|ACCESS_KEY|AUTH_TOKEN|TOKEN|PASSWORD|PRIVATE_KEY)(?:_[A-Z0-9_]*)?["']?\s*[:=]\s*["'`]?([A-Za-z0-9+/_~.=-]{20,})/,
    valueGroup: 1,
  },
];

export interface Finding {
  path: string;
  line: number;
  rule: string;
  engine: string;
}

/** A finding plus the line it was found on, kept only for allow-list matching. */
interface Located extends Finding {
  lineText: string;
}

const MAX_BYTES = 2 * 1024 * 1024;

/** A committed env file is a finding by itself, whatever it holds. */
export function isEnvFile(path: string): boolean {
  const name = basename(path);
  if (/\.(example|sample|template)$/i.test(name)) return false;
  return /^\.env(\..+)?$/.test(name) || /^\.dev\.vars(\..+)?$/.test(name);
}

/** Scan numbered lines with the built-in rules. */
export function scanLines(
  path: string,
  lines: Array<{ n: number; text: string }>,
  rules: Rule[] = RULES,
): Located[] {
  const out: Located[] = [];
  for (const { n, text } of lines) {
    for (const rule of rules) {
      const m = rule.re.exec(text);
      if (!m) continue;
      if (rule.valueGroup !== undefined && !looksRandom(m[rule.valueGroup] ?? "")) continue;
      out.push({ path, line: n, rule: rule.id, engine: "built-in", lineText: text });
      break; // one finding per line is enough to act on
    }
  }
  return out;
}

export function scanText(path: string, text: string, rules: Rule[] = RULES): Located[] {
  return scanLines(
    path,
    text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t })),
    rules,
  );
}

/** Added lines of a unified diff (`git diff --cached -U0`), by new-file line number. */
export function parseStagedDiff(diff: string): Map<string, Array<{ n: number; text: string }>> {
  const files = new Map<string, Array<{ n: number; text: string }>>();
  let path: string | null = null;
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      path = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (path !== null && !files.has(path)) files.set(path, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (path === null) continue;
    if (line.startsWith("+")) {
      files.get(path)?.push({ n, text: line.slice(1) });
      n++;
    } else if (line.startsWith(" ")) n++;
  }
  return files;
}

/** Does this allow-list entry cover the finding? */
export function allows(entry: SecretAllow, f: Located): boolean {
  if (!matchesGlob(f.path, entry.path)) return false;
  if (entry.rule !== undefined && entry.rule !== f.rule) return false;
  const re = new RegExp(entry.pattern);
  return re.test(f.lineText) || re.test(f.rule);
}

// ---------------------------------------------------------------- external engines

export interface EngineRun {
  engine: string;
  /** null when the engine is not installed. */
  findings: Finding[] | null;
  /** Set when the engine was found and failed: said, not hidden. */
  error?: string;
}

function rel(root: string, p: string): string {
  return (isAbsolute(p) ? relative(root, p) : p).split("\\").join("/");
}

/** TruffleHog JSON lines on stdout (`--json`); logs go to stderr. */
export function parseTrufflehog(root: string, stdout: string): Finding[] {
  const out: Finding[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const j = JSON.parse(line) as {
        DetectorName?: string;
        SourceMetadata?: { Data?: { Filesystem?: { file?: string; line?: number } } };
      };
      const fs = j.SourceMetadata?.Data?.Filesystem;
      if (!fs?.file) continue;
      out.push({
        path: rel(root, fs.file),
        line: fs.line ?? 0,
        rule: `trufflehog:${j.DetectorName ?? "unknown"}`,
        engine: "trufflehog",
      });
    } catch {
      // A non-JSON line is a log line; skip it.
    }
  }
  return out;
}

/** gitleaks `--report-format json --report-path -`: one JSON array. */
export function parseGitleaks(root: string, stdout: string): Finding[] {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  const arr = JSON.parse(stdout.slice(start)) as Array<{
    File?: string;
    StartLine?: number;
    RuleID?: string;
  }>;
  return arr
    .filter((x) => x.File)
    .map((x) => ({
      path: rel(root, x.File as string),
      line: x.StartLine ?? 0,
      rule: `gitleaks:${x.RuleID ?? "unknown"}`,
      engine: "gitleaks",
    }));
}

export async function runTrufflehog(exec: Exec, root: string, paths: string[]): Promise<EngineRun> {
  const probe = await exec("trufflehog", ["--version"], { cwd: root, timeoutMs: 15_000 });
  if (probe.notFound) return { engine: "trufflehog", findings: null };
  if (paths.length === 0) return { engine: "trufflehog", findings: [] };
  // --no-verification: verifying sends each candidate to its vendor, which is a
  // network call and a disclosure; the scan answers "is it here", not "is it live".
  const r = await exec(
    "trufflehog",
    ["filesystem", "--no-update", "--no-verification", "--json", ...paths],
    { cwd: root, timeoutMs: 300_000 },
  );
  if (r.code !== 0 && r.code !== 183)
    return {
      engine: "trufflehog",
      findings: [],
      error: r.timedOut ? "timed out" : firstLine(r.stderr || r.stdout) || `exit ${r.code}`,
    };
  return { engine: "trufflehog", findings: parseTrufflehog(root, r.stdout) };
}

export async function runGitleaks(exec: Exec, root: string, staged: boolean): Promise<EngineRun> {
  const probe = await exec("gitleaks", ["version"], { cwd: root, timeoutMs: 15_000 });
  if (probe.notFound) return { engine: "gitleaks", findings: null };
  // `git` mode reads history (full) or the index (--staged): gitleaks's own
  // notion of tracked content, and it never needs node_modules excluded.
  const args = [
    "git",
    "--no-banner",
    "--redact",
    "--exit-code",
    "0",
    "--report-format",
    "json",
    "--report-path",
    "-",
    ...(staged ? ["--pre-commit", "--staged"] : []),
    root,
  ];
  const r = await exec("gitleaks", args, { cwd: root, timeoutMs: 300_000 });
  if (r.code !== 0)
    return {
      engine: "gitleaks",
      findings: [],
      error: r.timedOut ? "timed out" : firstLine(r.stderr || r.stdout) || `exit ${r.code}`,
    };
  try {
    return { engine: "gitleaks", findings: parseGitleaks(root, r.stdout) };
  } catch (e) {
    return {
      engine: "gitleaks",
      findings: [],
      error: `unreadable report (${(e as Error).message})`,
    };
  }
}

// ---------------------------------------------------------------- the check

export interface SecretsOptions {
  root: string;
  exec: Exec;
  config: SecurityConfig;
  staged: boolean;
}

// The allow-list is never scanned: each `pattern` in it quotes the very text
// it allows, so scanning it reports every allowed finding a second time, at
// a line nobody can allow-list. Its shape is validated (config.mts), so a
// pattern is the only place a string can sit, and each is a reviewed entry.
function excluded(path: string, config: SecurityConfig): boolean {
  if (path === SECURITY_CONFIG_FILE) return true;
  return config.secrets.exclude.some((g) => matchesGlob(path, g));
}

function readLines(root: string, path: string): Array<{ n: number; text: string }> | null {
  const file = join(root, path);
  try {
    if (!existsSync(file) || statSync(file).size > MAX_BYTES) return null;
    const buf = readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return null; // binary
    return buf
      .toString("utf8")
      .split(/\r?\n/)
      .map((t, i) => ({ n: i + 1, text: t }));
  } catch {
    return null;
  }
}

export async function checkSecrets(opts: SecretsOptions): Promise<CheckResult> {
  const { root, exec, config, staged } = opts;
  const linesByPath = new Map<string, Array<{ n: number; text: string }>>();

  if (staged) {
    const d = await exec(
      "git",
      ["-c", "core.quotePath=false", "diff", "--cached", "-U0", "--no-color", "--no-ext-diff"],
      { cwd: root },
    );
    if (d.code !== 0)
      return result(
        "secrets",
        "could-not-run",
        `git diff --cached: ${firstLine(d.stderr) || `exit ${d.code}`}`,
      );
    for (const [p, lines] of parseStagedDiff(d.stdout))
      if (!excluded(p, config)) linesByPath.set(p, lines);
  } else {
    const ls = await exec("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: root });
    if (ls.code !== 0)
      return result(
        "secrets",
        "could-not-run",
        `git ls-files: ${firstLine(ls.stderr) || `exit ${ls.code}`}`,
      );
    for (const p of ls.stdout.split("\0").filter(Boolean)) {
      if (excluded(p, config)) continue;
      const lines = readLines(root, p);
      linesByPath.set(p, lines ?? []);
    }
  }

  const found: Located[] = [];
  for (const [p, lines] of linesByPath) {
    if (isEnvFile(p))
      found.push({
        path: p,
        line: 0,
        rule: "env-file-committed",
        engine: "built-in",
        lineText: "",
      });
    found.push(...scanLines(p, lines));
  }

  // External engines: merge, keyed by file:line so two engines on one line count once.
  const engines: string[] = ["built-in"];
  const notes: string[] = [];
  const runs = [
    await runGitleaks(exec, root, staged),
    await runTrufflehog(
      exec,
      root,
      [...linesByPath.keys()].filter((p) => existsSync(join(root, p))),
    ),
  ];
  for (const run of runs) {
    if (run.findings === null) continue;
    if (run.error) {
      notes.push(`${run.engine} failed (${run.error}); its findings are missing`);
      continue;
    }
    engines.push(run.engine);
    for (const f of run.findings) {
      if (excluded(f.path, config)) continue;
      const text = linesByPath.get(f.path)?.find((l) => l.n === f.line)?.text ?? "";
      found.push({ ...f, lineText: text });
    }
  }

  const seen = new Set<string>();
  const merged = found.filter((f) => {
    const k = `${f.path}:${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const used = new Set<number>();
  const open = merged.filter((f) => {
    const i = config.secrets.allow.findIndex((a) => allows(a, f));
    if (i >= 0) used.add(i);
    return i < 0;
  });

  const lines = open.map((f) => `${f.path}:${f.line}  ${f.rule}  (${f.engine})`);
  // A stale entry is judged only on a full scan: a staged diff is a subset.
  const stale = staged
    ? []
    : config.secrets.allow
        .map((a, i) => ({ a, i }))
        .filter(({ i }) => !used.has(i))
        .map(
          ({ a, i }) =>
            `allow-list entry ${i} (${a.path} /${a.pattern}/) matches nothing — remove it`,
        );
  lines.push(...stale, ...notes);

  const scope = staged ? `${linesByPath.size} staged file(s)` : `${linesByPath.size} tracked files`;
  const engineText = `engines: ${engines.join(" + ")}`;
  const allowed = used.size > 0 ? `, ${merged.length - open.length} allow-listed` : "";
  if (open.length > 0 || stale.length > 0)
    return result(
      "secrets",
      "fail",
      `${open.length} finding(s)${stale.length ? `, ${stale.length} stale allow-list entr${stale.length === 1 ? "y" : "ies"}` : ""} in ${scope}${allowed}; ${engineText}`,
      lines,
    );
  return result("secrets", "pass", `0 findings in ${scope}${allowed}; ${engineText}`, lines);
}
