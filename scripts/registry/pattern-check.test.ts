/**
 * The registry pattern check: green on this repository, and tripped one way at a
 * time on a small source tree built here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  importsOf,
  lockfileRootVersions,
  printResult,
  registryPatternCheck,
} from "./pattern-check.mts";
import type { Result } from "./pattern-check.mts";

const REPO = join(import.meta.dirname, "..", "..");

const problems = (r: Result) => [...r.global, ...r.rows.flatMap((x) => x.problems)];

describe("this repository", () => {
  it("passes: every file in one item or excluded, imports and dependencies declared", () => {
    const r = registryPatternCheck(REPO);
    const lines: string[] = [];
    const code = printResult(r, (l) => lines.push(l));
    console.log(lines.join("\n"));
    expect(problems(r)).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(code).toBe(0);
    // A pattern check that found nothing to count is broken, not green.
    expect(r.rows.find((x) => x.item === "base")?.files).toBeGreaterThan(100);
  });
});

// ─── a small source, tripped ──────────────────────────────────────────────────

let dir: string;
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

type Reg = {
  exclude: Record<string, string>;
  registryOnly: { scripts: Record<string, string> };
  items: Record<string, Record<string, unknown>>;
};
let reg: Reg;
const config = { ci: { steps: [{ name: "lint", run: "x", applies: "always" }] } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "registry-check-"));
  reg = {
    exclude: {
      "README.md": "this repository's own readme, never copied",
      "package.json": "this repository's own, compared with the fragments",
      "sdlc.config.json": "this repository's own, compared with the fragments",
      "pnpm-lock.yaml": "a project resolves its own lockfile",
    },
    registryOnly: { scripts: {} },
    items: {
      base: {
        kind: "base",
        description: "b",
        files: [
          "tooling/core/",
          { from: "template/package.json", to: "package.json", seed: true },
          { from: "template/sdlc.config.json", to: "sdlc.config.json", seed: true },
        ],
        package: { scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.11" } },
      },
      alpha: {
        kind: "module",
        description: "a",
        when: "the project needs alpha for something",
        files: ["tooling/alpha/"],
      },
      beta: {
        kind: "recipe",
        description: "b",
        when: "the project has a beta package",
        files: [{ from: "recipes/beta/", to: "packages/beta/" }],
      },
    },
  };
  write("README.md", "# x\n");
  write("template/package.json", json({ name: "", devDependencies: {} }));
  write("template/sdlc.config.json", json(config));
  write("sdlc.config.json", json(config));
  write(
    "package.json",
    json({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4.1.0" } }),
  );
  write(
    "pnpm-lock.yaml",
    "importers:\n\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^4.1.0\n        version: 4.1.11(@types/node@24)\n\n  tooling/core: {}\n",
  );
  write("tooling/core/src/a.mts", 'import { x } from "node:fs";\nimport { it } from "vitest";\n');
  write("tooling/alpha/src/b.mts", 'import { a } from "../../core/src/a.mts";\n');
  write("recipes/beta/package.json", json({ name: "@app/beta", dependencies: { zod: "4.1.0" } }));
  write("recipes/beta/src/c.ts", 'import { z } from "zod";\nimport { y } from "./d";\n');
  write("recipes/beta/src/d.ts", "export const y = 1;\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const check = () => {
  write("registry.json", json({ registryVersion: 1, repo: "x", ...reg }));
  return registryPatternCheck(dir);
};

describe("the pattern check, tripped", () => {
  it("passes the small source as built", () => {
    // registry.json itself must be excluded too.
    reg.exclude["registry.json"] = "the registry itself, never copied";
    const r = check();
    expect(problems(r)).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  describe("with registry.json excluded", () => {
    beforeEach(() => (reg.exclude["registry.json"] = "the registry itself, never copied"));

    it("a file in no item", () => {
      write("stray.txt", "x\n");
      expect(problems(check())).toEqual(["stray.txt belongs to no item and is not excluded"]);
    });

    it("a file in two items", () => {
      reg.items.alpha!.files = ["tooling/alpha/", "tooling/core/src/a.mts"];
      expect(problems(check())).toContain("tooling/core/src/a.mts belongs to base and alpha");
    });

    it("an exclusion that matches nothing, and one without a reason", () => {
      reg.exclude["gone.md"] = "a file that was deleted long ago";
      reg.exclude["README.md"] = "ours";
      const p = problems(check());
      expect(p).toContain('exclude "gone.md" matches no file: remove it');
      expect(p).toContain('exclude "README.md" needs a reason, not a label');
    });

    it("an import from an item that is not required", () => {
      write("tooling/core/src/e.mts", 'import { b } from "../../alpha/src/b.mts";\n');
      expect(problems(check()).join("\n")).toMatch(
        /tooling\/core\/src\/e\.mts imports \.\.\/\.\.\/alpha\/src\/b\.mts .* from alpha, which base does not require/,
      );
    });

    it("an import nothing installs", () => {
      write("recipes/beta/src/e.ts", 'import { q } from "./missing";\n');
      expect(problems(check()).join("\n")).toMatch(/imports \.\/missing, which no item installs/);
    });

    it("a requirement with no import and no reason; then with a reason", () => {
      reg.items.beta!.requires = ["alpha"];
      expect(problems(check())).toEqual([
        "requires alpha, but nothing it ships imports from alpha: say why in requiresBecause, or drop it",
      ]);
      reg.items.beta!.requiresBecause = { alpha: "it runs alpha's command" };
      expect(problems(check())).toEqual([]);
    });

    it("a requirement cycle", () => {
      reg.items.alpha!.requires = ["beta"];
      reg.items.alpha!.requiresBecause = { beta: "a reason" };
      reg.items.beta!.requires = ["alpha"];
      reg.items.beta!.requiresBecause = { alpha: "a reason" };
      expect(problems(check()).join("\n")).toMatch(/a requirement cycle/);
    });

    it("an undeclared npm import", () => {
      write("recipes/beta/src/f.ts", 'import { serve } from "hono";\n');
      expect(problems(check()).join("\n")).toMatch(
        /f\.ts imports hono, which packages\/beta\/package\.json and package\.json does not declare/,
      );
    });

    it("two items installing one path without a declared conflict; then declared one way only", () => {
      reg.items.gamma = {
        kind: "recipe",
        description: "g",
        files: [{ from: "recipes/gamma/", to: "packages/beta/" }],
      };
      write("recipes/gamma/src/d.ts", "export const y = 2;\n");
      expect(problems(check())).toContain(
        "packages/beta/src/d.ts is installed by both beta and gamma, which do not declare a conflict",
      );
      reg.items.gamma.conflicts = ["beta"];
      expect(problems(check())).toContain(
        "gamma conflicts with beta, but beta does not name gamma",
      );
    });

    it("an optional item that does not say when a project adds it", () => {
      delete reg.items.alpha?.when;
      expect(problems(check())).toContain(
        "when: say, in a sentence, when a project adds it (pnpm sdlc list prints it)",
      );
    });

    it("two versions of one package for one package.json", () => {
      reg.items.delta = {
        kind: "recipe",
        description: "d",
        files: [{ from: "recipes/delta/x.ts", to: "packages/beta/src/x.ts" }],
        packageJson: "packages/beta/package.json",
        package: { dependencies: { zod: "4.2.0" } },
      };
      write("recipes/delta/x.ts", "export {};\n");
      expect(problems(check())).toContain(
        "packages/beta/package.json: zod is 4.1.0 for beta and 4.2.0 for delta",
      );
    });

    it("a module script or pin that is not this repository's own", () => {
      (reg.items.base!.package as { scripts: Record<string, string> }).scripts.test = "jest";
      (
        reg.items.base!.package as { devDependencies: Record<string, string> }
      ).devDependencies.vitest = "4.1.10";
      const p = problems(check());
      expect(p).toContain('script test is "jest" here and "vitest run" in package.json');
      expect(p).toContain(
        "vitest is pinned to 4.1.10, and this repository's lockfile resolves 4.1.11",
      );
    });

    it("a base script this repository omits: declared, then present anyway", () => {
      write("package.json", json({ scripts: {}, devDependencies: { vitest: "^4.1.0" } }));
      expect(problems(check())).toContain(
        'script test is "vitest run" here and "undefined" in package.json',
      );
      (reg.registryOnly as { omit?: Record<string, string> }).omit = {
        test: "this repository runs its tests some other way",
      };
      expect(problems(check())).toEqual([]);
      write(
        "package.json",
        json({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^4.1.0" } }),
      );
      expect(problems(check())).toContain(
        "script test is in registryOnly.omit, yet package.json has it",
      );
    });

    it("a script in package.json that no item and no registryOnly entry accounts for", () => {
      write(
        "package.json",
        json({
          scripts: { test: "vitest run", extra: "x" },
          devDependencies: { vitest: "^4.1.0" },
        }),
      );
      expect(problems(check())).toContain(
        "package.json script extra belongs to no item and is not in registryOnly.scripts",
      );
    });

    it("this repository's sdlc.config.json drifting from the template plus fragments", () => {
      reg.items.alpha!.config = { ci: { steps: [{ name: "cov", run: "c", applies: "always" }] } };
      expect(problems(check()).join("\n")).toMatch(
        /sdlc\.config\.json is not template\/sdlc\.config\.json plus the modules' fragments/,
      );
      write(
        "sdlc.config.json",
        json({ ci: { steps: [...config.ci.steps, { name: "cov", run: "c", applies: "always" }] } }),
      );
      expect(problems(check())).toEqual([]);
    });

    it("could not ask: a lockfile it cannot read is reported, not passed", () => {
      rmSync(join(dir, "pnpm-lock.yaml"));
      delete reg.exclude["pnpm-lock.yaml"];
      const r = check();
      expect(r.unknown.join("\n")).toMatch(
        /could not read this repository's package.json or lockfile/,
      );
      expect(printResult(r, () => {})).toBe(2);
    });
  });
});

describe("the parts", () => {
  it("reads imports, not text that looks like one", () => {
    expect(
      importsOf(
        [
          'import a from "a";',
          'import type { B } from "@b/c/d";',
          'export { e } from "./e.ts";',
          'import "side";',
          'const m = await import("dyn");',
          '// import x from "commented";',
          '/* import y from "block"; */',
          'const fixture = `import z from "in-a-template";`;',
        ].join("\n"),
      ).sort(),
    ).toEqual(["./e.ts", "@b/c/d", "a", "dyn", "side"]);
  });
  it("reads the root importer's resolved versions from a lockfile", () => {
    const v = lockfileRootVersions(
      "importers:\n\n  .:\n    devDependencies:\n      '@a/b':\n        specifier: ^1\n        version: 1.2.3(x@1)\n      c:\n        specifier: ^2\n        version: 2.0.0\n\n  tooling/x:\n    dependencies:\n      d:\n        version: 9.9.9\n",
    );
    expect([...v]).toEqual([
      ["@a/b", "1.2.3"],
      ["c", "2.0.0"],
    ]);
  });
});
