/**
 * `starter-manifest.json`: what the starter owns in a project, and how
 * `pnpm sdlc:update` brings each owned path up to date.
 *
 *   replace      the starter's version wins outright (tooling/<module>/, docs/kit/,
 *                the starter's skills, .husky hooks). A project never edits these
 *   merge-json   the project's file is kept and the starter's is merged in:
 *                objects merge, arrays union by value, a project's value is never
 *                replaced or removed. With `keys`, only the listed keys under each
 *                named object are the starter's, and those take the starter's value
 *                (root package.json: the starter's scripts and devDependencies)
 *   merge-lines  missing lines are added, never removed (.gitignore, .gitattributes,
 *                pnpm-workspace.yaml)
 *
 * Read from the starter (`starter/main`) by sdlc:update, and from the project's
 * own copy (itself a `replace` entry) by upstreamPaths(), so the commit hook
 * warns about exactly what the next update would overwrite.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "./shape.mts";
import type { Shape } from "./shape.mts";

export const MANIFEST_FILE = "starter-manifest.json";
export const VERSION_FILE = ".sdlc-version";

export type OwnedKind = "replace" | "merge-json" | "merge-lines";

export interface OwnedPath {
  /** Repository-relative; a directory ends with `/`. */
  path: string;
  kind: OwnedKind;
  /** merge-json only: `{ "scripts": ["ci:local", …] }` — the starter owns just these keys. */
  keys?: Record<string, string[]>;
}

export interface StarterManifest {
  /** The starter's semver, recorded in a project's `.sdlc-version` by sdlc:update. */
  version: string;
  /** The oldest `configVersion` this starter's tooling understands. Default 1. */
  minConfigVersion?: number;
  owned: OwnedPath[];
}

export const MANIFEST_SHAPE: Shape = {
  t: "object",
  props: {
    version: { shape: { t: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" } },
    minConfigVersion: { shape: { t: "integer", min: 1 }, optional: true },
    owned: {
      shape: {
        t: "array",
        items: {
          t: "object",
          props: {
            path: { shape: { t: "string", minLength: 1 } },
            kind: { shape: { t: "enum", values: ["replace", "merge-json", "merge-lines"] } },
            keys: {
              shape: { t: "record", values: { t: "array", items: { t: "string", minLength: 1 } } },
              optional: true,
            },
          },
        },
      },
    },
  },
};

export function parseManifest(text: string, source = MANIFEST_FILE): StarterManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source} is not valid JSON: ${(e as Error).message}`);
  }
  const problems = check(MANIFEST_SHAPE, value);
  if (!problems.length) {
    const m = value as StarterManifest;
    const seen = new Set<string>();
    m.owned.forEach((o, i) => {
      if (o.path.startsWith("/") || o.path.split("/").includes(".."))
        problems.push(`owned[${i}].path: "${o.path}" must be relative, inside the repository`);
      if (seen.has(o.path)) problems.push(`owned[${i}].path: "${o.path}" is listed twice`);
      seen.add(o.path);
      if (o.keys && o.kind !== "merge-json")
        problems.push(`owned[${i}].keys: only a merge-json entry may name keys`);
    });
  }
  if (problems.length)
    throw new Error(`${source} is not a valid manifest:\n  ${problems.join("\n  ")}`);
  return value as StarterManifest;
}

/** The project's own copy, or null when it has none (a project from before manifests). */
export function loadManifest(root: string): StarterManifest | null {
  const path = join(root, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  return parseManifest(readFileSync(path, "utf8"), path);
}

/** `tooling/<name>/…` for a module the project replaced: the project's, not the starter's. */
export function isReplacedModule(path: string, replaced: string[]): boolean {
  const m = /^tooling\/([^/]+)(\/|$)/.exec(path);
  return m !== null && replaced.includes(m[1] as string);
}

/** The `replace` entries a project never edits in place, less its replaced modules. */
export function manifestUpstreamPaths(
  manifest: StarterManifest,
  replaced: string[] = [],
): string[] {
  return manifest.owned
    .filter((o) => o.kind === "replace" && !isReplacedModule(o.path, replaced))
    .map((o) => o.path);
}

/** Compare two `x.y.z` versions; anything unparsable sorts first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
}
