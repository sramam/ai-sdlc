import { describe, expect, it } from "vitest";
import { DEFAULTS, loadSecurityConfig, validateSecurityConfig } from "./config.mts";
import { tempRepo } from "./test-helpers.mts";

describe("security.config.json", () => {
  it("uses the defaults when the file is absent", () => {
    const r = loadSecurityConfig(tempRepo({}));
    expect(r).toEqual({ ok: true, config: DEFAULTS, source: "defaults" });
  });

  it("fills unset sections from the defaults", () => {
    const r = validateSecurityConfig({ deps: { failAt: "critical" } });
    expect(r.ok && r.config.deps.failAt).toBe("critical");
    expect(r.ok && r.config.licenses.allow).toEqual(DEFAULTS.licenses.allow);
  });

  it("refuses an allow-list entry whose reason is under three words", () => {
    const r = validateSecurityConfig({
      secrets: { allow: [{ path: "a", pattern: "b", reason: "test fixture" }] },
    });
    expect(r).toEqual({
      ok: false,
      problems: [
        'secrets.allow[0].reason: needs at least three words saying why, got "test fixture"',
      ],
    });
  });

  it("requires a reason on every kind of exception", () => {
    const r = validateSecurityConfig({
      deps: { ignore: [{ id: "GHSA-x" }] },
      licenses: { exceptions: [{ package: "p", reason: "one" }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems).toEqual(["deps.ignore[0].reason: required"]);
    const r2 = validateSecurityConfig({
      licenses: { exceptions: [{ package: "p", reason: "one" }] },
    });
    expect(!r2.ok && r2.problems[0]).toMatch(
      /^licenses.exceptions\[0\].reason: needs at least three words/,
    );
  });

  it("refuses unknown keys, bad severities and broken regexes", () => {
    expect(validateSecurityConfig({ secret: {} }).ok).toBe(false);
    expect(validateSecurityConfig({ deps: { failAt: "severe" } }).ok).toBe(false);
    const r = validateSecurityConfig({
      secrets: { allow: [{ path: "a", pattern: "(", reason: "three whole words" }] },
    });
    expect(!r.ok && r.problems[0]).toMatch(/pattern: not a valid regex/);
  });

  it("reports invalid JSON rather than throwing", () => {
    const r = loadSecurityConfig(tempRepo({ "security.config.json": "{" }));
    expect(!r.ok && r.problems[0]).toMatch(/not valid JSON/);
  });
});
