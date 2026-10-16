import { describe, expect, it } from "vitest";
import { exampleConfig } from "../../core/src/config.test-helper.mts";
import type { EnvironmentConfig } from "../../core/src/config.mts";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { ExecResult } from "../../core/src/exec.mts";
import { parseRollbackArgs, runRollback } from "./rollback.mts";

function run(env: EnvironmentConfig | undefined, answer: ExecResult = result(0)) {
  const exec = scriptedExec([[/^sh -c /, answer]]);
  const lines: string[] = [];
  const config = exampleConfig((c) => (c.environments = env ? { staging: env } : {}));
  const p = runRollback("staging", {
    exec,
    root: "/repo",
    loadConfig: async () => config,
    log: (l) => lines.push(l),
  });
  return { p, exec, out: () => lines.join("\n") };
}

const env: EnvironmentConfig = {
  branch: "staging",
  deploy: "d",
  rollback: "pnpm exec wrangler rollback --env staging",
};

describe("rollback", () => {
  it("runs the configured command and says the schema stays forward", async () => {
    const t = run(env);
    expect(await t.p).toBe(0);
    expect(t.exec.calls.map((c) => c.args[1])).toEqual([env.rollback]);
    expect(t.out()).toMatch(/schema stays forward/i);
    expect(t.out()).toMatch(/undoes no migration/);
    expect(t.out()).toMatch(/staging still names the newer commit/);
  });

  it("refuses an environment without a rollback command, running nothing", async () => {
    const t = run({ branch: "staging", deploy: "d" });
    expect(await t.p).toBe(1);
    expect(t.exec.calls).toEqual([]);
    expect(t.out()).toMatch(/rollback is not configured/);
    expect(await run(undefined).p).toBe(1);
  });

  it("a failing command is a failure; a missing binary is could-not-ask", async () => {
    expect(await run(env, result(1)).p).toBe(1);
    expect(await run(env, result(127)).p).toBe(2);
  });

  it("takes exactly one environment", () => {
    expect(parseRollbackArgs(["staging"])).toEqual({ env: "staging" });
    expect(parseRollbackArgs([])).toHaveProperty("error");
    expect(parseRollbackArgs(["a", "b"])).toHaveProperty("error");
    expect(parseRollbackArgs(["staging", "--yes"])).toHaveProperty("error");
  });
});
