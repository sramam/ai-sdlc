// pnpm recipes:check [--only a,b] [--keep] [--out <dir>]
//
// Builds each recipe in docs/kit/recipes into its own scratch workspace and runs
// what the recipe declares: install, typecheck, tests. Recipes are not wired
// into the starter's build (docs/kit/starter-repo.md), so this is the check that
// keeps them correct. It needs the network (pnpm install), so it is manual and
// never part of `pnpm test`. Each workspace gets the starter's minimumReleaseAge,
// so a recipe pinning a too-new version fails here as it would in a project.
//
// Every recipe gets one of four answers, never a silent pass:
//   pass           installed, typechecked (where declared), tests passed
//   fail           a step failed
//   could-not-run  a step reported exit 2 (an engine or service was unreachable)
//   not-checked    the recipe is not a standalone package; the reason is printed
//
// Exit: 1 if anything failed, 2 if nothing failed but something could not run,
// 0 otherwise.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const recipesDir = join(root, "docs/kit/recipes");

/**
 * Recipes the harness cannot build as they stand, each with the reason.
 */
const NOT_STANDALONE: Record<string, string> = {
  ui: "a kit copied into an app that `shadcn init` scaffolds (README § Instantiate); its package.json lists only what it adds",
};

/**
 * Recipes that are instantiated INTO another one (its README's table), and the
 * scripts run before typecheck. The fragments without a package.json are
 * checked here, inside the recipe that assembles them.
 */
const ASSEMBLE: Record<
  string,
  { copy: [from: string, to: string][]; before: string[]; workspace?: string }
> = {
  "app-tanstack-workers": {
    copy: [
      ["env-schema/src", "src"],
      ["db-drizzle/src", "src/db"],
      ["db-drizzle/drizzle.config.ts", "drizzle.config.ts"],
      ["telemetry/src", "src/telemetry"],
    ],
    // routeTree.gen.ts comes from the build; `typecheck` runs `wrangler types` itself.
    before: ["build"],
    // Exactly the root pnpm-workspace.yaml patch its README prescribes.
    workspace: "onlyBuiltDependencies:\n  - esbuild\n  - workerd\n  - sharp\n",
  },
};
/**
 * Recipes whose tests import a sibling recipe by its path in docs/kit/recipes
 * (`../../db-drizzle/src/…`). The sibling is copied beside the scratch
 * workspace, sharing its node_modules, so the relative import resolves.
 */
const SIBLINGS: Record<string, string[]> = {
  "dev-session": ["db-drizzle"],
  "api-bindings": ["api"],
};

/**
 * Files left out of the harness's typecheck, each with the reason. A CLI whose
 * imports are the paths it is instantiated at cannot resolve them here; it is
 * typechecked by the project once it is in place.
 */
const TS_EXCLUDE: Record<string, { files: string[]; reason: string }> = {
  "dev-session": {
    files: ["dev-session.mts"],
    reason:
      "dev-session.mts not typechecked: it imports tooling/ and apps/ at its instantiated path",
  },
};

const ASSEMBLED_INTO: Record<string, string> = Object.fromEntries(
  Object.entries(ASSEMBLE).flatMap(([into, a]) =>
    a.copy.map(([from]) => [from.split("/")[0]!, into]),
  ),
);

type Answer = "pass" | "fail" | "could-not-run" | "not-checked";
type Row = { recipe: string; answer: Answer; detail: string };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = value("--only")?.split(",");
const keep = flag("--keep");
const out = value("--out") ?? mkdtempSync(join(tmpdir(), "recipes-check-"));
mkdirSync(out, { recursive: true });

// When a recipe ships no tsconfig, its source is checked under the settings a
// project package gets: strict, bundler resolution (recipes import "./x").
const DEFAULT_TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: "ES2023",
    module: "ESNext",
    moduleResolution: "Bundler",
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    noEmit: true,
    types: ["node"],
  },
  include: ["**/*.ts", "**/*.mts"],
  exclude: ["node_modules"],
};

// The answer must not depend on how this was invoked: `pnpm run` hands its
// own settings to children as npm_config_* / pnpm_config_*, so those are dropped
// and the starter's supply-chain rule is written into each workspace instead.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(npm|pnpm)_config_/i.test(k)),
);
const releaseAge = /^minimumReleaseAge:\s*(\d+)/m.exec(
  readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
)?.[1];
const SUPPLY_CHAIN = releaseAge ? `minimumReleaseAge: ${releaseAge}\n` : "";

function step(cwd: string, cmd: string, cmdArgs: string[]): { code: number; tail: string } {
  console.log(`  $ ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    env: { ...childEnv, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  // A spawn that could not finish (buffer, signal) has no exit code; say why.
  const why = r.error ? `\n${r.error.message}` : r.signal ? `\nkilled by ${r.signal}` : "";
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}${why}`;
  const tail = text.trim().split("\n").slice(-15).join("\n");
  return { code: r.status ?? 1, tail };
}

function check(recipe: string): Row {
  const src = join(recipesDir, recipe);
  const pkgPath = join(src, "package.json");
  if (!existsSync(pkgPath)) {
    const into = ASSEMBLED_INTO[recipe];
    return {
      recipe,
      answer: "not-checked",
      detail: into
        ? `no package.json: checked inside ${into}, which assembles it`
        : "no package.json: a fragment adapted into another package (README)",
    };
  }
  if (NOT_STANDALONE[recipe])
    return { recipe, answer: "not-checked", detail: NOT_STANDALONE[recipe] };

  const dir = join(out, recipe);
  rmSync(dir, { recursive: true, force: true });
  cpSync(src, dir, { recursive: true, filter: (p) => !p.includes("node_modules") });
  for (const [from, to] of ASSEMBLE[recipe]?.copy ?? []) {
    cpSync(join(recipesDir, from), join(dir, to), { recursive: true });
  }
  for (const sibling of SIBLINGS[recipe] ?? []) {
    const to = join(out, sibling);
    rmSync(to, { recursive: true, force: true });
    cpSync(join(recipesDir, sibling), to, {
      recursive: true,
      filter: (p) => !p.includes("node_modules"),
    });
    symlinkSync(join(dir, "node_modules"), join(to, "node_modules"));
  }
  // A workspace of its own, so the starter's workspace settings do not apply.
  writeFileSync(
    join(dir, "pnpm-workspace.yaml"),
    `packages: []\n${SUPPLY_CHAIN}${ASSEMBLE[recipe]?.workspace ?? ""}`,
  );
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};

  console.log(`\n${recipe}`);
  const install = step(dir, "pnpm", ["install", "--no-frozen-lockfile"]);
  if (install.code !== 0)
    return { recipe, answer: "fail", detail: `install failed\n${install.tail}` };

  for (const name of ASSEMBLE[recipe]?.before ?? []) {
    const r = step(dir, "pnpm", ["run", name]);
    if (r.code !== 0) return { recipe, answer: "fail", detail: `${name} failed\n${r.tail}` };
  }

  const notes: string[] = [];
  if (!existsSync(join(dir, "tsconfig.json"))) {
    const excluded = TS_EXCLUDE[recipe];
    const tsconfig = {
      ...DEFAULT_TSCONFIG,
      exclude: [...DEFAULT_TSCONFIG.exclude, ...(excluded?.files ?? [])],
    };
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
    notes.push("typecheck used the harness's default tsconfig (the recipe ships none)");
    if (excluded) notes.push(excluded.reason);
  }
  const tc = scripts.typecheck
    ? step(dir, "pnpm", ["run", "typecheck"])
    : step(dir, "pnpm", ["exec", "tsc", "--noEmit"]);
  if (tc.code !== 0) return { recipe, answer: "fail", detail: `typecheck failed\n${tc.tail}` };

  const testScript = scripts["test:ci"] ? "test:ci" : "test";
  const t = step(dir, "pnpm", ["run", testScript]);
  const summary = t.tail
    .split("\n")
    .filter((l) => /Tests |Test Files |COULD NOT RUN/.test(l))
    .map((l) => l.trim())
    .join("; ");
  if (t.code === 2) return { recipe, answer: "could-not-run", detail: `${testScript}: ${summary}` };
  if (t.code !== 0) return { recipe, answer: "fail", detail: `${testScript} failed\n${t.tail}` };
  return { recipe, answer: "pass", detail: [summary, ...notes].filter(Boolean).join("; ") };
}

const recipes = readdirSync(recipesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => !only || only.includes(n))
  .sort();
const unknown = (only ?? []).filter((n) => !recipes.includes(n));
if (unknown.length) {
  console.error(`recipes-check: no such recipe: ${unknown.join(", ")}`);
  process.exit(1);
}

const rows = recipes.map(check);
console.log("\nrecipe                 answer          detail");
for (const r of rows) {
  const [first, ...rest] = r.detail.split("\n");
  console.log(`${r.recipe.padEnd(22)} ${r.answer.padEnd(15)} ${first ?? ""}`);
  if (r.answer === "fail") for (const l of rest) console.log(`${" ".repeat(39)}${l}`);
}
console.log(`\nscratch workspaces: ${out}${keep ? "" : " (removed)"}`);
if (!keep) rmSync(out, { recursive: true, force: true });

if (rows.some((r) => r.answer === "fail")) process.exit(1);
if (rows.some((r) => r.answer === "could-not-run")) process.exit(2);
