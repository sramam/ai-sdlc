import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { result as execResult, scriptedExec } from "../../core/src/exec.mts";
import { DEFAULTS } from "./config.mts";
import type { SecurityConfig } from "./config.mts";
import {
  checkSecrets,
  entropy,
  isEnvFile,
  looksRandom,
  parseGitleaks,
  parseStagedDiff,
  parseTrufflehog,
  RULES,
  scanText,
} from "./secrets.mts";
import { nearMisses, randomish, secretSamples, tempRepo } from "./test-helpers.mts";

const notFound = execResult(127);
const noEngines: Array<[RegExp, ReturnType<typeof execResult>]> = [
  [/^gitleaks /, notFound],
  [/^trufflehog /, notFound],
];

function withAllow(allow: SecurityConfig["secrets"]["allow"]): SecurityConfig {
  return { ...DEFAULTS, secrets: { allow, exclude: [] } };
}

describe("built-in rules", () => {
  const samples = secretSamples();

  it("has a tripping sample for every rule", () => {
    expect(Object.keys(samples).sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  for (const rule of RULES) {
    it(`trips ${rule.id}`, () => {
      const found = scanText("f.txt", `before\n${samples[rule.id]}\nafter`);
      expect(found.map((f) => [f.rule, f.line])).toEqual([[rule.id, 2]]);
    });
  }

  it("passes near misses: placeholders, words, short values", () => {
    for (const line of nearMisses()) expect(scanText("f.txt", line), line).toEqual([]);
  });

  it("judges an assignment by its value", () => {
    expect(looksRandom(randomish(32))).toBe(true);
    expect(looksRandom("abcdefghijklmnopqrstuvwxyz")).toBe(false); // no digit
    expect(looksRandom(`${randomish(16)}-example`)).toBe(false);
    expect(entropy("aaaa")).toBe(0);
  });

  it("does not trip on its own sources or on the skill", () => {
    const here = new URL(".", import.meta.url).pathname;
    const files = readdirSync(here).map((f) => join(here, f));
    files.push(join(here, "../../../.claude/skills/security-review/SKILL.md"));
    files.push(join(here, "../README.md"));
    for (const f of files) expect(scanText(f, readFileSync(f, "utf8")), f).toEqual([]);
  });
});

describe("env files", () => {
  it("flags a committed env file and spares the examples", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("apps/web/.env.local")).toBe(true);
    expect(isEnvFile(".dev.vars")).toBe(true);
    expect(isEnvFile(".env.example")).toBe(false);
    expect(isEnvFile("docs/env.md")).toBe(false);
  });
});

describe("checkSecrets (full scan)", () => {
  it("fails on a tracked secret, naming file, line and rule, never the value", async () => {
    const key = secretSamples()["stripe-secret-key"] as string;
    const root = tempRepo({ "src/a.ts": `x\n${key}\n`, "README.md": "fine" });
    const exec = scriptedExec([
      [/^git .*ls-files/, execResult(0, "src/a.ts\0README.md\0")],
      ...noEngines,
    ]);
    const r = await checkSecrets({ root, exec, config: DEFAULTS, staged: false });
    expect(r.state).toBe("fail");
    expect(r.lines).toEqual(["src/a.ts:2  stripe-secret-key  (built-in)"]);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.detail).toContain("engines: built-in");
  });

  it("passes a clean tree and says which engine ran", async () => {
    const root = tempRepo({ "a.ts": "const x = 1;\n" });
    const exec = scriptedExec([[/ls-files/, execResult(0, "a.ts\0")], ...noEngines]);
    const r = await checkSecrets({ root, exec, config: DEFAULTS, staged: false });
    expect(r.state).toBe("pass");
    expect(r.detail).toBe("0 findings in 1 tracked files; engines: built-in");
  });

  it("fails a committed .env whatever it holds", async () => {
    const root = tempRepo({ ".env": "A=1\n" });
    const exec = scriptedExec([[/ls-files/, execResult(0, ".env\0")], ...noEngines]);
    const r = await checkSecrets({ root, exec, config: DEFAULTS, staged: false });
    expect(r.lines).toEqual([".env:0  env-file-committed  (built-in)"]);
  });

  it("honours an allow-list entry, and fails one that matches nothing", async () => {
    const root = tempRepo({ "fixtures/k.txt": `${secretSamples()["github-token"]}\n` });
    const exec = scriptedExec([[/ls-files/, execResult(0, "fixtures/k.txt\0")], ...noEngines]);
    const allowed = await checkSecrets({
      root,
      exec,
      staged: false,
      config: withAllow([
        { path: "fixtures/**", pattern: "github-token", reason: "a published revoked sample" },
      ]),
    });
    expect(allowed.state).toBe("pass");
    expect(allowed.detail).toContain("1 allow-listed");

    const stale = await checkSecrets({
      root,
      exec,
      staged: false,
      config: withAllow([
        { path: "fixtures/**", pattern: "github-token", reason: "a published revoked sample" },
        { path: "nowhere/*", pattern: ".", reason: "left over from before" },
      ]),
    });
    expect(stale.state).toBe("fail");
    expect(stale.lines).toEqual(["allow-list entry 1 (nowhere/* /./) matches nothing — remove it"]);
  });

  it("merges trufflehog findings, once per file:line", async () => {
    const sample = secretSamples()["aws-access-key-id"] as string;
    const root = tempRepo({ "a.txt": `${sample}\n`, "b.txt": "nothing\n" });
    const th = [
      { DetectorName: "AWS", SourceMetadata: { Data: { Filesystem: { file: "a.txt", line: 1 } } } },
      {
        DetectorName: "Generic",
        SourceMetadata: { Data: { Filesystem: { file: "b.txt", line: 1 } } },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n");
    const exec = scriptedExec([
      [/ls-files/, execResult(0, "a.txt\0b.txt\0")],
      [/^gitleaks /, notFound],
      ["trufflehog --version", execResult(0, "trufflehog 3.90.0")],
      [/^trufflehog filesystem/, execResult(0, th)],
    ]);
    const r = await checkSecrets({ root, exec, config: DEFAULTS, staged: false });
    expect(r.detail).toContain("engines: built-in + trufflehog");
    expect(r.lines).toEqual([
      "a.txt:1  aws-access-key-id  (built-in)",
      "b.txt:1  trufflehog:Generic  (trufflehog)",
    ]);
    const call = exec.calls.find((c) => c.args[0] === "filesystem");
    expect(call?.args).toContain("--no-verification");
  });

  it("degrades to built-in when an installed engine crashes, and says so", async () => {
    const root = tempRepo({ "a.txt": "ok\n" });
    const exec = scriptedExec([
      [/ls-files/, execResult(0, "a.txt\0")],
      ["gitleaks version", execResult(0, "8.24.0")],
      [/^gitleaks git/, execResult(1, "", "fatal: something broke")],
      [/^trufflehog /, notFound],
    ]);
    const r = await checkSecrets({ root, exec, config: DEFAULTS, staged: false });
    expect(r.state).toBe("pass");
    expect(r.detail).toContain("engines: built-in");
    expect(r.lines).toEqual(["gitleaks failed (fatal: something broke); its findings are missing"]);
  });

  it("could not run when git cannot list files", async () => {
    const exec = scriptedExec([[/ls-files/, execResult(128, "", "fatal: not a git repository")]]);
    const r = await checkSecrets({ root: tempRepo({}), exec, config: DEFAULTS, staged: false });
    expect(r.state).toBe("could-not-run");
    expect(r.detail).toContain("not a git repository");
  });
});

describe("checkSecrets --staged", () => {
  const sample = secretSamples()["slack-token"] as string;
  const diff = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -3,0 +4,2 @@",
    "+const a = 1;",
    `+const t = "${sample}";`,
    "diff --git a/old.ts b/old.ts",
    "--- a/old.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    `-${sample}`,
  ].join("\n");

  it("reads added lines with their new line numbers, and skips deletions", () => {
    const files = parseStagedDiff(diff);
    expect([...files.keys()]).toEqual(["src/x.ts"]);
    expect(files.get("src/x.ts")?.map((l) => l.n)).toEqual([4, 5]);
  });

  it("fails on a staged secret and ignores stale allow-list entries", async () => {
    const exec = scriptedExec([[/diff --cached/, execResult(0, diff)], ...noEngines]);
    const r = await checkSecrets({
      root: tempRepo({}),
      exec,
      staged: true,
      config: withAllow([{ path: "other/**", pattern: ".", reason: "unrelated to this diff" }]),
    });
    expect(r.state).toBe("fail");
    expect(r.lines).toEqual(["src/x.ts:5  slack-token  (built-in)"]);
    expect(r.detail).toContain("1 staged file(s)");
  });
});

describe("engine report parsers", () => {
  it("reads trufflehog lines and skips logs", () => {
    const out = `{"level":"info"}\nnot json\n${JSON.stringify({
      DetectorName: "Stripe",
      SourceMetadata: { Data: { Filesystem: { file: "/r/a.ts", line: 3 } } },
    })}`;
    expect(parseTrufflehog("/r", out)).toEqual([
      { path: "a.ts", line: 3, rule: "trufflehog:Stripe", engine: "trufflehog" },
    ]);
  });

  it("reads a gitleaks report", () => {
    const out = JSON.stringify([{ File: "a.ts", StartLine: 7, RuleID: "github-pat" }]);
    expect(parseGitleaks("/r", out)).toEqual([
      { path: "a.ts", line: 7, rule: "gitleaks:github-pat", engine: "gitleaks" },
    ]);
  });
});
