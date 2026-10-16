import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "./config.mts";
import type { SecurityConfig } from "./config.mts";
import { checkInstallScripts, installHooks, readBuildPolicy } from "./install-scripts.mts";
import { checkLicenses, declaredLicense, evaluateLicense } from "./licenses.mts";
import { listInstalled } from "./packages.mts";
import { pnpmPackage, tempRepo } from "./test-helpers.mts";

const ALLOW = DEFAULTS.licenses.allow;
const WARN = DEFAULTS.licenses.warn;

describe("listInstalled", () => {
  it("reads pnpm's layout, skipping dependency symlinks and dedupe by name@version", () => {
    const root = tempRepo({
      ...pnpmPackage({ name: "a", version: "1.0.0" }),
      ...pnpmPackage({ name: "@s/b", version: "2.0.0" }),
    });
    // a depends on @s/b: pnpm links it beside a — that link is not a second package.
    symlinkSync(
      join(root, "node_modules/.pnpm/@s+b@2.0.0/node_modules/@s/b"),
      join(root, "node_modules/.pnpm/a@1.0.0/node_modules/b-link"),
    );
    expect(listInstalled(root)?.map((p) => `${p.name}@${p.version}`)).toEqual([
      "@s/b@2.0.0",
      "a@1.0.0",
    ]);
  });

  it("is null, not empty, without node_modules/.pnpm", () => {
    expect(listInstalled(tempRepo({}))).toBeNull();
  });
});

describe("licenses", () => {
  it("reads every declared form", () => {
    expect(declaredLicense({ license: "MIT" })).toBe("MIT");
    expect(declaredLicense({ license: { type: "ISC" } })).toBe("ISC");
    expect(declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "(MIT OR Apache-2.0)",
    );
    expect(declaredLicense({})).toBeNull();
  });

  it("evaluates SPDX expressions: OR takes the best, AND the worst", () => {
    expect(evaluateLicense("(MIT OR GPL-3.0)", ALLOW, WARN)).toBe("allow");
    expect(evaluateLicense("MIT AND GPL-3.0", ALLOW, WARN)).toBe("deny");
    expect(evaluateLicense("MPL-2.0", ALLOW, WARN)).toBe("warn");
    expect(evaluateLicense("Apache-2.0 WITH LLVM-exception", ALLOW, WARN)).toBe("allow");
    expect(evaluateLicense("SEE LICENSE IN LICENSE.md", ALLOW, WARN)).toBeNull();
  });

  const repo = tempRepo({
    ...pnpmPackage({ name: "ok", version: "1.0.0", license: "MIT" }),
    ...pnpmPackage({ name: "weak", version: "1.0.0", license: "MPL-2.0" }),
    ...pnpmPackage({ name: "copyleft", version: "1.0.0", license: "GPL-3.0-only" }),
    ...pnpmPackage({ name: "none", version: "1.0.0" }),
  });

  it("fails a license outside the allow-list and an undeclared one; MPL warns", () => {
    const r = checkLicenses(listInstalled(repo), DEFAULTS);
    expect(r.state).toBe("fail");
    expect(r.lines).toEqual([
      "copyleft@1.0.0: GPL-3.0-only",
      "none@1.0.0: no license declared",
      "warn  weak@1.0.0: MPL-2.0",
    ]);
  });

  it("passes with reasoned exceptions, and fails one that excuses nothing", () => {
    const cfg = (extra: SecurityConfig["licenses"]["exceptions"]): SecurityConfig => ({
      ...DEFAULTS,
      licenses: {
        ...DEFAULTS.licenses,
        exceptions: [
          { package: "copyleft", reason: "build tool, never shipped" },
          { package: "none@1.0.0", reason: "MIT in its LICENSE file" },
          ...extra,
        ],
      },
    });
    expect(checkLicenses(listInstalled(repo), cfg([])).state).toBe("pass");
    const stale = checkLicenses(
      listInstalled(repo),
      cfg([{ package: "gone", reason: "no longer here" }]),
    );
    expect(stale.state).toBe("fail");
    expect(stale.lines).toContain("exception 2 (gone) excuses nothing installed — remove it");
  });

  it("could not run without an install", () => {
    expect(checkLicenses(null, DEFAULTS).state).toBe("could-not-run");
  });
});

describe("install-scripts pattern check", () => {
  const scripted = pnpmPackage({
    name: "native",
    version: "1.0.0",
    scripts: { postinstall: "node x" },
  });
  const gyp = pnpmPackage({ name: "gyp", version: "1.0.0" }, { "binding.gyp": "{}" });
  const plain = pnpmPackage({ name: "plain", version: "1.0.0", scripts: { test: "x" } });

  it("finds declared and implicit node-gyp hooks", () => {
    const root = tempRepo({ ...scripted, ...gyp, ...plain });
    const hooks = Object.fromEntries(
      (listInstalled(root) ?? []).map((p) => [p.name, installHooks(p)]),
    );
    expect(hooks).toEqual({
      gyp: ["install (implicit node-gyp)"],
      native: ["postinstall"],
      plain: [],
    });
  });

  it("passes when unlisted packages are denied, and reports them", () => {
    const root = tempRepo({ ...scripted, "pnpm-workspace.yaml": "onlyBuiltDependencies: []\n" });
    const r = checkInstallScripts(listInstalled(root), readBuildPolicy(root));
    expect(r.state).toBe("pass");
    expect(r.lines).toEqual(["denied   native@1.0.0  postinstall"]);
  });

  it("passes an allowed package that still has its script", () => {
    const root = tempRepo({
      ...scripted,
      "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - native # reviewed\n",
    });
    const r = checkInstallScripts(listInstalled(root), readBuildPolicy(root));
    expect(r.state).toBe("pass");
    expect(r.lines).toEqual(["allowed  native@1.0.0  postinstall"]);
  });

  it("fails a listed package that has no script or is not installed — the list only shrinks", () => {
    const root = tempRepo({
      ...plain,
      "pnpm-workspace.yaml": "onlyBuiltDependencies: [plain, gone]\n",
    });
    const r = checkInstallScripts(listInstalled(root), readBuildPolicy(root));
    expect(r.state).toBe("fail");
    expect(r.lines).toEqual([
      "onlyBuiltDependencies lists plain, which no longer has an install script — remove it",
      "onlyBuiltDependencies lists gone, which is not installed — remove it",
    ]);
  });

  it("fails a policy that lets an unlisted package run", () => {
    const allowAll = tempRepo({
      ...scripted,
      "pnpm-workspace.yaml": "dangerouslyAllowAllBuilds: true\nonlyBuiltDependencies: []\n",
    });
    const r = checkInstallScripts(listInstalled(allowAll), readBuildPolicy(allowAll));
    expect(r.state).toBe("fail");
    expect(r.lines).toContain("allowed  native@1.0.0  postinstall");

    const denyList = tempRepo({
      ...scripted,
      "pnpm-workspace.yaml": "neverBuiltDependencies: [x]\nonlyBuiltDependencies: []\n",
    });
    expect(checkInstallScripts(listInstalled(denyList), readBuildPolicy(denyList)).state).toBe(
      "fail",
    );

    const undeclared = tempRepo({ ...scripted, "pnpm-workspace.yaml": "packages: []\n" });
    const u = checkInstallScripts(listInstalled(undeclared), readBuildPolicy(undeclared));
    expect(u.state).toBe("fail");
    expect(u.lines[0]).toMatch(/no onlyBuiltDependencies declared/);
  });

  it("reads the root package.json pnpm block too", () => {
    const root = tempRepo({
      ...scripted,
      "package.json": JSON.stringify({ pnpm: { onlyBuiltDependencies: ["native"] } }),
    });
    expect(checkInstallScripts(listInstalled(root), readBuildPolicy(root)).lines).toEqual([
      "allowed  native@1.0.0  postinstall",
    ]);
  });

  it("could not run without an install, or with a policy file it cannot read", () => {
    expect(checkInstallScripts(null, readBuildPolicy(tempRepo({}))).state).toBe("could-not-run");
    const root = tempRepo({
      ...scripted,
      "pnpm-workspace.yaml": "onlyBuiltDependenciesFile: x.json\n",
    });
    expect(checkInstallScripts(listInstalled(root), readBuildPolicy(root)).state).toBe(
      "could-not-run",
    );
  });
});
