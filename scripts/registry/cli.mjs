#!/usr/bin/env node
// @ts-check
/**
 * ai-sdlc — copy the kit's items into a project, and keep them in step.
 *
 *   ai-sdlc init <dir> [--from <dir> | --ref <ref>] [--no-install] [--no-commit]
 *   ai-sdlc add <item…> [--from <dir> | --ref <ref>]
 *   ai-sdlc list
 *   ai-sdlc diff <item> [--from <dir> | --ref <ref>]
 *   ai-sdlc update <item> [--from <dir> | --ref <ref>] [--accept <file>]…
 *
 * Plain JavaScript with JSDoc types and no dependencies: it runs from
 * node_modules under `pnpm dlx github:sramam/ai-sdlc#<ref>`, where Node refuses
 * to strip TypeScript types (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
 * docs/kit/registry.md describes the model.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { add, diff, init, list, update } from "./commands.mjs";

const USAGE = `usage:
  ai-sdlc init <dir> [--from <dir> | --ref <ref>] [--no-install] [--no-commit]
  ai-sdlc add <item…> [--from <dir> | --ref <ref>]
  ai-sdlc list [--from <dir> | --ref <ref>]
  ai-sdlc diff <item> [--from <dir> | --ref <ref>]
  ai-sdlc update <item> [--from <dir> | --ref <ref>] [--accept <file>]…

--from <dir>   read the registry from a local directory (tests, offline use)
--ref <ref>    a tag, branch or commit of --repo (default github:sramam/ai-sdlc)`;

/**
 * @param {string[]} argv
 * @returns {{ command: string | undefined, args: string[], from?: string, ref?: string, repo?: string, install: boolean, commit: boolean, accept: string[], bad: string[] }}
 */
export function parseArgs(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  const out = { command: argv[0], args: [], install: true, commit: true, accept: [], bad: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) out.bad.push(`${a} needs a value`);
      return v;
    };
    if (a === "--from") out.from = value();
    else if (a === "--ref") out.ref = value();
    else if (a === "--repo") out.repo = value();
    else if (a === "--accept") out.accept.push(value() ?? "");
    else if (a === "--no-install") out.install = false;
    else if (a === "--no-commit") out.commit = false;
    else if (a.startsWith("--")) out.bad.push(`unknown option ${a}`);
    else out.args.push(a);
  }
  return out;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  const cliPath = fileURLToPath(import.meta.url);
  const pkg = JSON.parse(readFileSync(join(dirname(cliPath), "..", "..", "package.json"), "utf8"));
  const p = parseArgs(argv);
  const ctx = {
    cwd: process.cwd(),
    log: (/** @type {string} */ l) => console.log(l),
    version: pkg.version,
    cliPath,
  };
  if (p.command === "--version" || p.command === "-v") {
    console.log(pkg.version);
    return 0;
  }
  if (!p.command || p.command === "--help" || p.command === "-h" || p.command === "help") {
    console.log(USAGE);
    return p.command ? 0 : 1;
  }
  if (p.bad.length) {
    console.error(`${p.bad.join("; ")}\n${USAGE}`);
    return 1;
  }
  const src = { from: p.from, ref: p.ref, repo: p.repo };
  try {
    switch (p.command) {
      case "init":
        if (p.args.length !== 1) break;
        return init(ctx, /** @type {string} */ (p.args[0]), {
          ...src,
          install: p.install,
          commit: p.commit,
        });
      case "add":
        return add(ctx, p.args, src);
      case "list":
        return list(ctx, src);
      case "diff":
        if (p.args.length !== 1) break;
        return diff(ctx, /** @type {string} */ (p.args[0]), src);
      case "update":
        if (p.args.length !== 1) break;
        return update(ctx, /** @type {string} */ (p.args[0]), { ...src, accept: p.accept });
      default:
        console.error(`unknown command ${p.command}`);
    }
  } catch (e) {
    console.error(`ai-sdlc: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
  console.error(USAGE);
  return 1;
}

// Run when invoked, not when imported by a test. Under dlx argv[1] is the bin
// symlink, so both sides are resolved.
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  process.exit(main(process.argv.slice(2)));
