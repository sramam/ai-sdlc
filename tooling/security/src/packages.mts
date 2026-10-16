/**
 * Every installed third-party package, read from pnpm's layout:
 * `node_modules/.pnpm/<id>/node_modules/<name>/package.json`. Inside `<id>`,
 * the package itself is a real directory and its dependencies are symlinks, so
 * `lstat` tells them apart without reading the lockfile.
 *
 * `null` means there is no `.pnpm` directory to read: not installed, or not
 * pnpm. That is could-not-ask, never "no packages".
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface InstalledPackage {
  name: string;
  version: string;
  dir: string;
  pkg: Record<string, unknown>;
}

function realDirs(parent: string): string[] {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const p = join(parent, n);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    if (n.startsWith("@")) out.push(...realDirs(p));
    else out.push(p);
  }
  return out;
}

export function listInstalled(root: string): InstalledPackage[] | null {
  const store = join(root, "node_modules", ".pnpm");
  if (!existsSync(store)) return null;
  const seen = new Set<string>();
  const out: InstalledPackage[] = [];
  for (const id of readdirSync(store)) {
    if (id === "node_modules") continue; // pnpm's hoisting directory: symlinks only
    const nm = join(store, id, "node_modules");
    for (const dir of realDirs(nm)) {
      const file = join(dir, "package.json");
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const name = typeof pkg.name === "string" ? pkg.name : null;
      const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
      if (!name) continue;
      const key = `${name}@${version}`;
      if (seen.has(key)) continue; // one package, several peer-dependency variants
      seen.add(key);
      out.push({ name, version, dir, pkg });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}
