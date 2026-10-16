import { describe, expect, it } from "vitest";
import { exec, firstLine, formatDuration, result, scriptedExec } from "./exec.mts";

describe("exec", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const r = await exec("node", [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ]);
    expect(r).toMatchObject({
      code: 3,
      stdout: "out",
      stderr: "err",
      timedOut: false,
      notFound: false,
    });
  });

  it("reports a missing binary as notFound and 127", async () => {
    const r = await exec("definitely-not-a-binary-sdlc", []);
    expect(r.notFound).toBe(true);
    expect(r.code).toBe(127);
  });

  it("kills a process that waits too long, and says it timed out", async () => {
    const r = await exec("node", ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it("closes stdin, so a prompt reads EOF rather than hanging", async () => {
    const r = await exec(
      "node",
      ["-e", "process.stdin.on('data',()=>{}); process.stdin.on('end',()=>process.exit(0))"],
      {
        timeoutMs: 5000,
      },
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  });
});

describe("scriptedExec", () => {
  it("answers the first matching rule and records the call", async () => {
    const fake = scriptedExec([
      ["git status", result(0, "clean")],
      [/^git /, result(1)],
    ]);
    expect((await fake("git", ["status"])).stdout).toBe("clean");
    expect((await fake("git", ["log"])).code).toBe(1);
    expect(fake.calls.map((c) => c.args[0])).toEqual(["status", "log"]);
  });

  it("treats an unscripted command as not found, so a forgotten rule is loud", async () => {
    const fake = scriptedExec([]);
    expect((await fake("gh", ["api"])).notFound).toBe(true);
  });
});

describe("helpers", () => {
  it("firstLine skips blanks and bounds the length", () => {
    expect(firstLine("\n\n  hello \nworld")).toBe("hello");
    expect(firstLine("x".repeat(100), 10)).toHaveLength(10);
  });
  it("formatDuration", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(12_300)).toBe("12.3s");
    expect(formatDuration(125_000)).toBe("2m5s");
  });
});
