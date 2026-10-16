import { describe, expect, it } from "vitest";
import { result as execResult, scriptedExec } from "../../core/src/exec.mts";
import { DEFAULTS } from "./config.mts";
import type { SecurityConfig } from "./config.mts";
import { checkDeps } from "./deps.mts";
import { checkReleaseAge, versionAtLeast } from "./release-age.mts";
import { tempRepo } from "./test-helpers.mts";
import { parseTopLevelYaml } from "./workspace-yaml.mts";

const advisory = (id: number, severity: string, module_name = "pkg") => ({
  id,
  github_advisory_id: `GHSA-${id}`,
  module_name,
  severity,
  patched_versions: ">=2.0.0",
  title: "t",
  findings: [{ version: "1.0.0", paths: [`.>${module_name}`] }],
});
const audit = (...a: ReturnType<typeof advisory>[]) =>
  execResult(1, JSON.stringify({ advisories: Object.fromEntries(a.map((x) => [x.id, x])) }));

describe("deps", () => {
  it("fails at or above high by default, counting what is below", async () => {
    const exec = scriptedExec([
      ["pnpm audit --json", audit(advisory(1, "critical", "tinypool"), advisory(2, "moderate"))],
    ]);
    const r = await checkDeps(exec, "/r", DEFAULTS);
    expect(r.state).toBe("fail");
    expect(r.detail).toBe("1 advisory at or above high; below threshold: 1 moderate");
    expect(r.lines[0]).toMatch(
      /^critical {2}tinypool@1.0.0 {2}GHSA-1 via .>tinypool — fixed in >=2.0.0/,
    );
  });

  it("passes when everything is below the configured threshold", async () => {
    const exec = scriptedExec([["pnpm audit --json", audit(advisory(1, "high"))]]);
    const cfg: SecurityConfig = { ...DEFAULTS, deps: { failAt: "critical", ignore: [] } };
    expect((await checkDeps(exec, "/r", cfg)).state).toBe("pass");
  });

  it("honours a reasoned ignore, and fails one that matches nothing", async () => {
    const exec = scriptedExec([["pnpm audit --json", audit(advisory(1, "critical"))]]);
    const cfg = (ids: string[]): SecurityConfig => ({
      ...DEFAULTS,
      deps: {
        failAt: "high",
        ignore: ids.map((id) => ({ id, reason: "dev only, not reachable" })),
      },
    });
    expect((await checkDeps(exec, "/r", cfg(["GHSA-1"]))).state).toBe("pass");
    const stale = await checkDeps(exec, "/r", cfg(["GHSA-1", "GHSA-9"]));
    expect(stale.state).toBe("fail");
    expect(stale.lines).toEqual([
      "ignore entry 1 (GHSA-9) matches no current advisory — remove it",
    ]);
  });

  it("could not run: no pnpm, a timeout, a registry error, or no JSON", async () => {
    const cases = [
      execResult(127),
      { ...execResult(null), timedOut: true },
      execResult(
        1,
        JSON.stringify({ error: { code: "ENOTFOUND", summary: "getaddrinfo ENOTFOUND registry" } }),
      ),
      execResult(1, "", "ERR_PNPM_AUDIT_BAD_RESPONSE  The audit endpoint responded with 503"),
    ];
    for (const c of cases) {
      const r = await checkDeps(scriptedExec([["pnpm audit --json", c]]), "/r", DEFAULTS);
      expect(r.state, r.detail).toBe("could-not-run");
    }
  });
});

describe("release-age", () => {
  const pnpm = (version: string, configValue: string) =>
    scriptedExec([
      ["pnpm --version", execResult(0, `${version}\n`)],
      ["pnpm config get minimumReleaseAge", execResult(0, `${configValue}\n`)],
    ]);
  const declared = tempRepo({ "pnpm-workspace.yaml": "minimumReleaseAge: 1440 # a day\n" });

  it("passes when declared in the repo and read by pnpm", async () => {
    const r = await checkReleaseAge(pnpm("10.28.2", "1440"), declared, DEFAULTS);
    expect(r.state).toBe("pass");
    expect(r.detail).toBe(
      "minimumReleaseAge 1440 min (pnpm-workspace.yaml; pnpm 10.28.2 reads it)",
    );
  });

  it("accepts .npmrc's spelling", async () => {
    const root = tempRepo({ ".npmrc": "minimum-release-age=2880\n" });
    expect((await checkReleaseAge(pnpm("10.28.2", "2880"), root, DEFAULTS)).state).toBe("pass");
  });

  it("fails when unset, even if a user config sets it", async () => {
    const r = await checkReleaseAge(pnpm("10.28.2", "60"), tempRepo({}), DEFAULTS);
    expect(r.state).toBe("fail");
    expect(r.detail).toMatch(/^unset in the repository .*user config/);
  });

  it("fails when too short, or when pnpm does not read what is declared", async () => {
    const short = tempRepo({ "pnpm-workspace.yaml": "minimumReleaseAge: 10\n" });
    expect((await checkReleaseAge(pnpm("10.28.2", "10"), short, DEFAULTS)).state).toBe("fail");
    const r = await checkReleaseAge(pnpm("10.28.2", "undefined"), declared, DEFAULTS);
    expect(r.state).toBe("fail");
    expect(r.detail).toMatch(/reads no minimumReleaseAge/);
  });

  it("fails on a pnpm that predates the setting", async () => {
    const r = await checkReleaseAge(pnpm("9.15.0", "undefined"), declared, DEFAULTS);
    expect(r.state).toBe("fail");
    expect(r.detail).toMatch(/predates minimumReleaseAge/);
  });

  it("could not run without pnpm, naming what it looked for", async () => {
    const r = await checkReleaseAge(scriptedExec([]), declared, DEFAULTS);
    expect(r.state).toBe("could-not-run");
    expect(r.detail).toMatch(/minimumReleaseAge. in pnpm-workspace.yaml/);
  });

  it("compares versions", () => {
    expect(versionAtLeast("10.16.0", [10, 16, 0])).toBe(true);
    expect(versionAtLeast("10.15.9", [10, 16, 0])).toBe(false);
    expect(versionAtLeast("11.0.0", [10, 16, 0])).toBe(true);
    expect(versionAtLeast("nope", [10, 16, 0])).toBeNull();
  });
});

describe("parseTopLevelYaml", () => {
  it("reads scalars, flow lists, block lists, and marks nested maps", () => {
    const y = parseTopLevelYaml(
      [
        "# comment",
        "packages:",
        '  - "tooling/*"',
        "onlyBuiltDependencies: [esbuild, 'sharp']",
        "minimumReleaseAge: 1440 # one day",
        "catalog:",
        "  react: ^19",
      ].join("\n"),
    );
    expect(y.get("packages")).toEqual(["tooling/*"]);
    expect(y.get("onlyBuiltDependencies")).toEqual(["esbuild", "sharp"]);
    expect(y.get("minimumReleaseAge")).toBe(1440);
    expect(y.get("catalog")).toEqual({ complex: true });
  });
});
