// pnpm recipes:check [--only a,b] [--keep] [--out <dir>]
//
// Installs each recipe into a scratch project the way a project gets it —
// `ai-sdlc init`, then `ai-sdlc add <recipe>` — and runs what its `check` in
// registry.json declares: install, typecheck, tests. Recipes are not built in
// this repository, so this is the check that keeps them correct, and it proves
// each one installs through `add` (its targets, its requirements, its merges)
// rather than in a layout of its own. It needs the network or a warm pnpm
// store, so it is manual and never part of `pnpm test`. Each project gets the
// kit's minimumReleaseAge from base, so a recipe pinning a too-new version
// fails here as it would in a project.
//
// Every recipe gets one of four answers, never a silent pass:
//   pass           installed, typechecked, tests passed
//   fail           a step failed
//   could-not-run  a step reported exit 2 (an engine or service was unreachable)
//   not-checked    the recipe's check says why (a fragment checked inside the
//                  recipe that requires it, or one that needs a scaffold)
//
// Exit: 1 if anything failed, 2 if nothing failed but something could not run,
// 0 otherwise.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { add, init } from "./registry/commands.mjs";
import { loadRegistry } from "./registry/registry.mjs";

const root = resolve(import.meta.dirname, "..");
const reg = loadRegistry(root);

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

// When a package ships no tsconfig, its source is checked under the settings a
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
// own settings to children as npm_config_* / pnpm_config_*.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(npm|pnpm)_config_/i.test(k)),
);

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
  return { code: r.status ?? 1, tail: text.trim().split("\n").slice(-15).join("\n") };
}

function check(recipe: string): Row {
  const c = reg.items[recipe]?.check ?? {};
  if (c.skip) return { recipe, answer: "not-checked", detail: c.skip };
  if (c.via)
    return { recipe, answer: "not-checked", detail: `checked inside ${c.via}, which requires it` };
  if (!c.dir) return { recipe, answer: "not-checked", detail: "registry.json gives it no check" };

  console.log(`\n${recipe}`);
  const logs: string[] = [];
  const ctx = {
    cwd: out,
    log: (l: string) => logs.push(l),
    version: "0.0.0",
    cliPath: join(root, "scripts/registry/cli.mjs"),
  };
  rmSync(join(out, recipe), { recursive: true, force: true });
  if (init(ctx, recipe, { from: root, install: false, commit: false }) !== 0)
    return { recipe, answer: "fail", detail: `init failed\n${logs.slice(-10).join("\n")}` };
  const proj = join(out, recipe);
  const items = [...(c.with ?? []), recipe];
  console.log(`  $ ai-sdlc add ${items.join(" ")}`);
  if (add({ ...ctx, cwd: proj }, items, {}) !== 0)
    return { recipe, answer: "fail", detail: `add failed\n${logs.slice(-10).join("\n")}` };

  const install = step(proj, "pnpm", ["install", "--no-frozen-lockfile"]);
  if (install.code !== 0)
    return { recipe, answer: "fail", detail: `install failed\n${install.tail}` };
  const dir = join(proj, c.dir);
  for (const name of c.before ?? []) {
    const r = step(dir, "pnpm", ["run", name]);
    if (r.code !== 0) return { recipe, answer: "fail", detail: `${name} failed\n${r.tail}` };
  }

  const notes: string[] = [];
  const atRoot = c.dir === ".";
  const scripts = atRoot
    ? {}
    : ((
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {});
  let tc;
  if (atRoot) tc = step(dir, "pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"]);
  else if (scripts.typecheck) tc = step(dir, "pnpm", ["run", "typecheck"]);
  else {
    if (!existsSync(join(dir, "tsconfig.json"))) {
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(DEFAULT_TSCONFIG, null, 2));
      notes.push("typecheck used the harness's default tsconfig (the recipe ships none)");
    }
    tc = step(dir, "pnpm", ["exec", "tsc", "--noEmit"]);
  }
  if (tc.code !== 0) return { recipe, answer: "fail", detail: `typecheck failed\n${tc.tail}` };

  const testScript = c.test ?? (scripts["test:ci"] ? "test:ci" : "test");
  const t = c.vitest
    ? step(dir, "pnpm", ["exec", "vitest", "run", ...c.vitest])
    : step(dir, "pnpm", ["run", testScript]);
  const label = c.vitest ? `vitest run ${c.vitest.join(" ")}` : testScript;
  const summary = t.tail
    .split("\n")
    .filter((l) => /Tests |Test Files |COULD NOT RUN/.test(l))
    .map((l) => l.trim())
    .join("; ");
  if (t.code === 2) return { recipe, answer: "could-not-run", detail: `${label}: ${summary}` };
  if (t.code !== 0) return { recipe, answer: "fail", detail: `${label} failed\n${t.tail}` };
  return { recipe, answer: "pass", detail: [summary, ...notes].filter(Boolean).join("; ") };
}

const recipes = Object.entries(reg.items)
  .filter(([n, i]) => i.kind === "recipe" && (!only || only.includes(n)))
  .map(([n]) => n)
  .sort();
const unknown = (only ?? []).filter((n) => reg.items[n]?.kind !== "recipe");
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
console.log(`\nscratch projects: ${out}${keep ? "" : " (removed)"}`);
if (!keep) rmSync(out, { recursive: true, force: true });

if (rows.some((r) => r.answer === "fail")) process.exit(1);
if (rows.some((r) => r.answer === "could-not-run")) process.exit(2);
