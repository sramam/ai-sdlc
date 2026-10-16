import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exec as realExec, result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult, ScriptedCall } from "../../core/src/exec.mts";
import { MERGED_MARKER, REPORT_PATH, stampedFingerprint } from "./coverage-lib.mts";
import type { CoverageJson, Floors } from "./coverage-lib.mts";
import {
  classifyRun,
  fingerprintInputs,
  moduleResolver,
  parseArgs,
  providerArgs,
  runCoverage,
} from "./coverage.mts";
import type { CoverageDeps, CoverageOptions } from "./coverage.mts";
import { fileCov } from "./fixtures.test-helper.mts";

let root: string;
let lines: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coverage-"));
  lines = [];
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const opts = (o: Partial<CoverageOptions> = {}): CoverageOptions => ({
  report: false,
  unitOnly: false,
  force: false,
  ...o,
});

/** A vitest that "writes" the given coverage, chosen by whether --config is present. */
function fakeVitest(unit: CoverageJson | ExecResult, integration?: CoverageJson | ExecResult) {
  const answer = (cov: CoverageJson | ExecResult) => (call: ScriptedCall) => {
    if ("code" in cov) return cov as ExecResult;
    const dir = call.args.find((a) => a.startsWith("--coverage.reportsDirectory="))!.split("=")[1]!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "coverage-final.json"), JSON.stringify(cov));
    return result(0, "✓ passed\n");
  };
  return scriptedExec([
    [/^git rev-parse --short HEAD$/, result(0, "abc1234\n")],
    [/^git rev-parse --abbrev-ref HEAD$/, result(0, "dev\n")],
    [/^pnpm exec vitest run --config /, answer(integration ?? result(1, "", "no integration"))],
    [/^pnpm exec vitest run /, answer(unit)],
  ]);
}

function deps(exec: CoverageDeps["exec"], floors: Floors = {}): CoverageDeps {
  return {
    root,
    floors,
    exec,
    vitest: ["pnpm", "exec", "vitest"],
    env: {},
    log: (l) => lines.push(l),
    selfFiles: [],
    timeoutMs: 10_000,
  };
}

const at = (path: string) => join(root, path);
const vitestCalls = (exec: { calls: ScriptedCall[] }) =>
  exec.calls.filter((c) => c.cmd === "pnpm").length;

describe("parseArgs", () => {
  it("reads the flags and refuses --report with --only", () => {
    expect(parseArgs(["--report", "--force"])).toEqual(opts({ report: true, force: true }));
    expect(parseArgs(["--only", "src"])).toEqual(opts({ only: "src" }));
    expect(parseArgs(["--only=src", "--unit-only"])).toEqual(opts({ only: "src", unitOnly: true }));
    expect(parseArgs(["--only"])).toHaveProperty("error");
    expect(parseArgs(["--report", "--only", "src"])).toHaveProperty("error");
    expect(parseArgs(["--nope"])).toHaveProperty("error");
  });
});

describe("classifyRun", () => {
  it("separates a red suite from a tool that could not run", () => {
    const json = at("none.json");
    expect(classifyRun(result(1, "1 failed"), json)).toMatchObject({ ok: false, exit: 1 });
    expect(classifyRun(result(127), json)).toMatchObject({ ok: false, exit: 2 });
    expect(
      classifyRun(
        result(1, "", "MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'"),
        json,
      ),
    ).toMatchObject({ ok: false, exit: 2 });
    expect(classifyRun(result(0), json)).toMatchObject({ ok: false, exit: 2 });
  });
});

describe("runCoverage", () => {
  const unitCov = () => ({ [at("src/a.ts")]: fileCov([1, 0, 0, 0], [[1, 0]]) });
  const integCov = () => ({ [at("src/a.ts")]: fileCov([0, 1, 1, 0], [[0, 1]]) });

  it("with no floors prints n/a, passes, and an unchanged tree then skips", async () => {
    const exec = fakeVitest(unitCov());
    const first = await runCoverage(opts(), deps(exec));
    expect(first).toMatchObject({ exit: 0, state: "pass" });
    expect(lines.join("\n")).toContain("[ n/a  ] floors");
    expect(readdirSync(at(".ci-local")).filter((f) => f.startsWith("coverage-"))).toHaveLength(1);

    const again = await runCoverage(opts(), deps(exec));
    expect(again).toMatchObject({ exit: 0, state: "skipped", fingerprint: first.fingerprint });
    expect(vitestCalls(exec)).toBe(1);

    // --force runs anyway; a changed source misses the cache.
    await runCoverage(opts({ force: true }), deps(exec));
    writeFileSync(at("src/a.ts"), "export const a = 2;\n");
    const changed = await runCoverage(opts(), deps(exec));
    expect(changed.state).toBe("pass");
    expect(vitestCalls(exec)).toBe(3);
  });

  it("merges the integration suite when its config exists, and gates the merged figure", async () => {
    writeFileSync(at("vitest.integration.config.ts"), "export default {};\n");
    const exec = fakeVitest(unitCov(), integCov());
    const floors = { src: { lines: 75, branches: 100 } };
    const outcome = await runCoverage(opts({ report: true }), deps(exec, floors));
    // Unit alone: 25% lines, 50% branches. Merged: 75% and 100%.
    expect(outcome).toMatchObject({ exit: 0, state: "pass" });
    const report = readFileSync(at(REPORT_PATH), "utf8");
    expect(report).toContain(MERGED_MARKER);
    expect(report).toContain("| `src` | 75 / 100 | 75.0% / 100.0% | pass |");
    expect(stampedFingerprint(report)).toBe(outcome.fingerprint);
  });

  it("a missed floor fails, leaves the report unstamped and caches nothing", async () => {
    const exec = fakeVitest(unitCov());
    const outcome = await runCoverage(
      opts({ report: true }),
      deps(exec, { src: { lines: 50, branches: 0 } }),
    );
    expect(outcome).toMatchObject({ exit: 1, state: "fail" });
    expect(lines.join("\n")).toContain("lines: 25.00% < 50%");
    expect(stampedFingerprint(readFileSync(at(REPORT_PATH), "utf8"))).toBeNull();
    expect(existsSync(at(".ci-local"))).toBe(false);
    // A red run is never skipped past.
    expect(
      (await runCoverage(opts({ report: true }), deps(exec, { src: { lines: 50, branches: 0 } })))
        .exit,
    ).toBe(1);
    expect(vitestCalls(exec)).toBe(2);
  });

  it("a unit-only run reports but does not judge, and will not overwrite a merged report", async () => {
    writeFileSync(at("vitest.integration.config.ts"), "export default {};\n");
    const exec = fakeVitest(unitCov());
    const floors = { src: { lines: 90, branches: 90 } };
    const outcome = await runCoverage(opts({ unitOnly: true }), deps(exec, floors));
    expect(outcome).toMatchObject({ exit: 0, state: "reported" });
    expect(lines.join("\n")).toContain("Reported, not judged");
    expect(exec.calls.some((c) => c.args.includes("--config"))).toBe(false);
    expect(existsSync(at(".ci-local"))).toBe(false);

    mkdirSync(at("docs/quality"), { recursive: true });
    writeFileSync(at(REPORT_PATH), `from ${MERGED_MARKER}\n`);
    const refused = await runCoverage(opts({ unitOnly: true, report: true }), deps(exec, floors));
    expect(refused).toMatchObject({ exit: 2, state: "could-not-run" });
    const forced = await runCoverage(
      opts({ unitOnly: true, report: true, force: true }),
      deps(exec, floors),
    );
    expect(forced.exit).toBe(0);
    expect(readFileSync(at(REPORT_PATH), "utf8")).toContain("**the unit suite only**");
  });

  it("--only filters the run, lists files weakest first, and never judges", async () => {
    const exec = fakeVitest(unitCov());
    const outcome = await runCoverage(
      opts({ only: "src" }),
      deps(exec, { src: { lines: 99, branches: 99 } }),
    );
    expect(outcome).toMatchObject({ exit: 0, state: "reported" });
    expect(exec.calls.find((c) => c.cmd === "pnpm")!.args.at(-1)).toBe("src");
    expect(lines.join("\n")).toContain("src/a.ts");
  });

  it("a red suite fails; a missing vitest could not run", async () => {
    expect((await runCoverage(opts(), deps(fakeVitest(result(1, "1 failed"))))).exit).toBe(1);
    expect((await runCoverage(opts(), deps(fakeVitest(result(127))))).exit).toBe(2);
  });

  it("rewriting an unchanged report is byte-identical", async () => {
    const exec = fakeVitest(unitCov());
    await runCoverage(opts({ report: true }), deps(exec));
    const first = readFileSync(at(REPORT_PATH), "utf8");
    await runCoverage(opts({ report: true, force: true }), deps(exec));
    expect(readFileSync(at(REPORT_PATH), "utf8")).toBe(first);
  });
});

describe("moduleResolver", () => {
  it("names the nearest package.json directory", () => {
    mkdirSync(at("tooling/ci/src"), { recursive: true });
    writeFileSync(at("tooling/ci/package.json"), "{}");
    const mod = moduleResolver(root);
    expect(mod("tooling/ci/src/x.ts")).toBe("tooling/ci");
    expect(mod("src/a.ts")).toBe(".");
  });
});

/**
 * One real run: vitest and @vitest/coverage-v8 against a two-suite fixture. The
 * fixture lives inside this package so the provider resolves from its
 * node_modules; its tests are `*.spec.ts` under a dot directory, which the
 * repository's own vitest include never collects.
 */
describe("a real run", () => {
  const here = fileURLToPath(new URL("..", import.meta.url));
  const vitestBin = fileURLToPath(
    new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  let fixture: string;
  beforeEach(() => {
    fixture = mkdtempSync(join(here, ".fixture-"));
    mkdirSync(join(fixture, "src"));
    writeFileSync(
      join(fixture, "src", "math.ts"),
      "export function sign(x: number) {\n  if (x > 0) {\n    return 1;\n  }\n  return -1;\n}\n" +
        "export function twice(x: number) {\n  return x * 2;\n}\n",
    );
    writeFileSync(
      join(fixture, "src", "math.spec.ts"),
      'import { expect, it } from "vitest";\nimport { sign } from "./math.ts";\nit("sign", () => expect(sign(1)).toBe(1));\n',
    );
    writeFileSync(
      join(fixture, "src", "math.int.spec.ts"),
      'import { expect, it } from "vitest";\nimport { sign, twice } from "./math.ts";\n' +
        'it("both", () => { expect(sign(-1)).toBe(-1); expect(twice(2)).toBe(4); });\n',
    );
    const cfg = (include: string) =>
      `export default { test: { include: ["${include}"] }, coverage: {} };\n`;
    writeFileSync(join(fixture, "vitest.config.mjs"), cfg("src/math.spec.ts"));
    writeFileSync(join(fixture, "vitest.integration.config.mjs"), cfg("src/math.int.spec.ts"));
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  const realRun = (o: CoverageOptions, log: string[]) =>
    runCoverage(o, {
      root: fixture,
      floors: { src: { lines: 100, branches: 50 } },
      exec: realExec,
      vitest: [process.execPath, vitestBin],
      env: process.env,
      log: (l) => log.push(l),
      selfFiles: [],
      timeoutMs: 100_000,
    });

  it(
    "merges both suites; only the merged figure meets the lines floor",
    { timeout: 120_000 },
    async () => {
      const log: string[] = [];
      const outcome = await realRun(opts({ report: true }), log);
      expect(outcome, log.join("\n")).toMatchObject({ exit: 0, state: "pass" });
      const report = readFileSync(join(fixture, REPORT_PATH), "utf8");
      expect(report).toContain(MERGED_MARKER);
      expect(report).toContain("| `src` | 100 / 50 | 100.0% /");

      // The unit suite alone never calls `twice`, so that run reads below the floor.
      const unitLog: string[] = [];
      expect((await realRun(opts({ unitOnly: true }), unitLog)).state).toBe("reported");
      expect(unitLog.find((l) => l.includes("unit run only"))).toMatch(
        /src\s+unit run only: \d\d\.\d\d% lines/,
      );
    },
  );
});

describe("providerArgs", () => {
  it("uses the root's provider when it has one, else this package's copy", () => {
    expect(providerArgs(root, "/x/index.js").args[0]).toBe("--coverage.provider=custom");
    expect(providerArgs(root, null).args).toEqual(["--coverage.provider=v8"]);
    mkdirSync(at("node_modules/@vitest/coverage-v8"), { recursive: true });
    expect(providerArgs(root, "/x/index.js")).toEqual({ args: ["--coverage.provider=v8"] });
  });
});

describe("fingerprintInputs", () => {
  it("takes nested source, configs and the lockfile; skips output, docs, dot dirs and deps", () => {
    const put = (p: string) => {
      mkdirSync(dirname(at(p)), { recursive: true });
      writeFileSync(at(p), "x");
    };
    for (const p of [
      "tooling/coverage/src/x.mts",
      "vitest.config.ts",
      "pnpm-lock.yaml",
      "coverage/index.js",
      "docs/kit/a.ts",
      ".claude/worktrees/w/src/y.ts",
      "node_modules/z/index.js",
    ])
      put(p);
    const rel = fingerprintInputs(root, [])
      .map((f) => f.slice(root.length + 1))
      .sort();
    expect(rel).toEqual([
      "pnpm-lock.yaml",
      "src/a.ts",
      "tooling/coverage/src/x.mts",
      "vitest.config.ts",
    ]);
  });
});
