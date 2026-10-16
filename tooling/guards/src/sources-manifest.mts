/**
 * The sources manifest: every file under `docs/requirements/sources/` is
 * recorded with its sha256, so an edit to source material is caught however it
 * was made — the requirements lock sees Edit and Write, not `sed -i` or `cp`.
 *
 *   node tooling/guards/src/sources-manifest.mts --add <path>   record a new import
 *   node tooling/guards/src/sources-manifest.mts --check        the pattern check, for ci
 *
 * `docs/requirements/sources/MANIFEST`, one line per file, the format
 * `sha256sum` writes and `shasum -a 256 -c` reads:
 *
 *     <64 hex sha256>  <path relative to sources/>
 *
 * so `cd docs/requirements/sources && shasum -a 256 -c MANIFEST` verifies it by
 * hand. The pattern check fails on a file with no line, a changed hash, a line naming
 * a file that is gone (a source is never deleted either), a malformed line and
 * a duplicate. Dotfiles (`.gitkeep`, `.DS_Store`) and MANIFEST itself are not
 * sources. `--add` refuses to re-record a path whose hash differs: a source is
 * immutable once imported, and re-recording it is exactly the edit this exists
 * to catch.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { findRoot } from "../../core/src/config.mts";
import { isEntry } from "../../core/src/exec.mts";
import { requirementsDir } from "./requirements-lock.mts";

export const MANIFEST = "MANIFEST";

export type ManifestCheck = {
  state: "ok" | "refused";
  /** Files under sources/ that were compared. */
  checked: number;
  problems: string[];
};

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function sourcesDir(root: string, reqDir = "docs/requirements"): string {
  return join(root, reqDir.replace(/\/+$/, ""), "sources");
}

/** Every source file, relative to sources/, `/`-separated, sorted. */
export function listSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(dir, p).split(sep).join("/");
        if (rel !== MANIFEST) out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

type Line = { hash: string; path: string };

export function parseManifest(text: string): { lines: Line[]; problems: string[] } {
  const lines: Line[] = [];
  const problems: string[] = [];
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(raw);
    if (!m) problems.push(`MANIFEST line ${i + 1} is not "<sha256>  <path>": ${raw}`);
    else lines.push({ hash: m[1]!, path: m[2]! });
  });
  return { lines, problems };
}

/** The pattern check: sources/ and its MANIFEST agree, file for file and hash for hash. */
export function checkSourcesManifest(root: string, reqDir = "docs/requirements"): ManifestCheck {
  const dir = sourcesDir(root, reqDir);
  const files = listSources(dir);
  const manifestPath = join(dir, MANIFEST);
  const { lines, problems } = existsSync(manifestPath)
    ? parseManifest(readFileSync(manifestPath, "utf8"))
    : { lines: [] as Line[], problems: [] as string[] };

  const recorded = new Map<string, string>();
  for (const l of lines) {
    if (recorded.has(l.path)) problems.push(`${l.path} is recorded twice`);
    recorded.set(l.path, l.hash);
  }
  for (const f of files) {
    const want = recorded.get(f);
    if (want === undefined)
      problems.push(`${f} has no MANIFEST line — record an import with sources-manifest.mts --add`);
    else if (sha256(join(dir, f)) !== want)
      problems.push(`${f} has changed since it was imported — sources are never edited`);
  }
  const present = new Set(files);
  for (const p of recorded.keys())
    if (!present.has(p))
      problems.push(`${p} is in MANIFEST but not on disk — sources are never deleted`);

  return { state: problems.length ? "refused" : "ok", checked: files.length, problems };
}

export type AddResult = { ok: boolean; message: string };

/** Append `<sha256>  <path>` for a source file; idempotent for an unchanged one. */
export function addSource(root: string, file: string, reqDir = "docs/requirements"): AddResult {
  const dir = sourcesDir(root, reqDir);
  const abs = resolve(root, file);
  const rel = relative(dir, abs);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep))
    return { ok: false, message: `${file} is not under ${relative(root, dir)}/` };
  const path = rel.split(sep).join("/");
  if (path === MANIFEST || path.split("/").some((part) => part.startsWith(".")))
    return { ok: false, message: `${path} is not a source` };
  if (!existsSync(abs) || statSync(abs).isDirectory())
    return { ok: false, message: `${file} is not a file` };

  const hash = sha256(abs);
  const manifestPath = join(dir, MANIFEST);
  const text = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
  const existing = parseManifest(text).lines.find((l) => l.path === path);
  if (existing)
    return existing.hash === hash
      ? { ok: true, message: `${path} already recorded` }
      : {
          ok: false,
          message: `${path} is recorded with a different hash — a source is immutable once imported; import the new version under a new name`,
        };
  const sep_ = text && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(manifestPath, `${sep_}${hash}  ${path}\n`);
  return { ok: true, message: `recorded ${hash.slice(0, 12)}…  ${path}` };
}

export async function main(argv: string[]): Promise<number> {
  const root = findRoot() ?? process.cwd();
  const reqDir = await requirementsDir(root);
  const ai = argv.indexOf("--add");
  if (ai >= 0) {
    const file = argv[ai + 1];
    if (!file) {
      console.error("sources-manifest: --add needs a path");
      return 2;
    }
    const r = addSource(root, resolve(process.cwd(), file), reqDir);
    (r.ok ? console.log : console.error)(`sources-manifest: ${r.message}`);
    return r.ok ? 0 : 1;
  }
  if (argv.includes("--check")) {
    const r = checkSourcesManifest(root, reqDir);
    console.log(
      `  ${r.state === "ok" ? "ok" : "REFUSED"}       sources       ${r.checked} file(s) under ${reqDir}/sources/` +
        (r.problems.length ? "" : ", every one matching MANIFEST"),
    );
    for (const p of r.problems) console.log(`      ${p}`);
    return r.state === "ok" ? 0 : 1;
  }
  console.error("usage: sources-manifest.mts --add <path> | --check");
  return 2;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
