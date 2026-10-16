/**
 * Third-party skills: copied in verbatim, pinned to a commit, never edited here.
 *
 *   node scripts/registry/third-party.mts check
 *   node scripts/registry/third-party.mts sync <name> [--ref <ref>]
 *   node scripts/registry/third-party.mts sync <name> --repo <url> --path <p>… --wrap <glob>… --license <id> [--ref <ref>]
 *
 * Each source lives in `.agents/3rdparty/<name>/`, laid out as upstream lays it
 * out (so its own relative links still resolve), with a `SOURCE.json` naming the
 * repository, the ref, the commit, the paths taken and every file's SHA-256.
 * `sync` clones the repository into a temporary directory, prints what changed
 * upstream since the recorded commit, replaces the copy and rewrites
 * `SOURCE.json`. It never touches our side.
 *
 * Our side is a **wrapper** per upstream entry (a skill, an agent, a command):
 * `.agents/skills/<name>/SKILL.md` or `.claude/agents/<name>.md`, whose
 * frontmatter names it (`metadata.upstream`) and whose body links to it and adds
 * this project's amendments. Agents never load `.agents/3rdparty/` directly, so
 * an upstream instruction we amend is always read with its amendment beside it.
 *
 * `check` (also run by `pnpm test`) holds both sides to the tree:
 *   - every copied file is byte-for-byte what `SOURCE.json` recorded, and
 *     nothing else is there
 *   - every upstream entry has exactly one wrapper (or a reason it has none),
 *     every wrapper names an entry that exists and links to it
 *   - a wrapper's description is upstream's, so it triggers where upstream's
 *     would (unless `metadata.own-description` says why not)
 *   - every skill in `.agents/skills/` is visible to Claude Code through a
 *     `.claude/skills/<name>` symlink, and nothing else is in `.claude/skills/`
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import {
  AGENT_SKILLS as SKILLS,
  CLAUDE_SKILLS,
  ensureSkillLinks,
  skillLinkTarget,
} from "../../tooling/core/src/skill-links.mjs";

export const THIRD_PARTY = ".agents/3rdparty";
export const CLAUDE_AGENTS = ".claude/agents";
export const SOURCE_FILE = "SOURCE.json";

export interface Source {
  repo: string;
  ref: string;
  commit: string;
  license: string;
  /** Upstream paths taken; a trailing `/` takes a directory. */
  paths: string[];
  /** Globs (`*` within one segment) of the upstream files that need a wrapper. */
  wrap: string[];
  /** Upstream entries deliberately left without a wrapper, with the reason. */
  unwrapped?: Record<string, string>;
  /** Every copied file (upstream path) and its SHA-256. */
  files: Record<string, string>;
}

export interface Frontmatter {
  fields: Record<string, string>;
  metadata: Record<string, string>;
  body: string;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * The frontmatter a skill, agent or command file opens with: top-level scalars
 * (plain, quoted, or a `|` / `>` block folded to one line, since they are only
 * compared) and the `metadata:` map one level down.
 */
export function frontmatter(text: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, metadata: {}, body: text };
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  const lines = (m[1] ?? "").split(/\r?\n/);
  let section: Record<string, string> = fields;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    const nested = /^ {2}([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    const kv = top ?? (section === metadata ? nested : null);
    if (!kv) continue;
    if (top) section = fields;
    const key = kv[1] ?? "";
    let value = (kv[2] ?? "").trim();
    if (top && key === "metadata" && value === "") {
      section = metadata;
      continue;
    }
    const indent = top ? 0 : 2;
    if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1] ?? "")) {
        const next = lines[i + 1] ?? "";
        if (next.length - next.trimStart().length <= indent && next.trim()) break;
        block.push(next.trim());
        i++;
      }
      value = block.filter(Boolean).join(" ");
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    section[key] = value;
  }
  return { fields, metadata, body: m[2] ?? "" };
}

/** `*` matches within one path segment; everything else is literal. */
export function globMatch(glob: string, path: string): boolean {
  const re = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${re}$`).test(path);
}

/** Every regular file under `dir`, relative, with `/`. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

export function readSource(root: string, name: string): Source {
  return JSON.parse(readFileSync(join(root, THIRD_PARTY, name, SOURCE_FILE), "utf8"));
}

export function sourceNames(root: string): string[] {
  const dir = join(root, THIRD_PARTY);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, SOURCE_FILE)))
    .map((e) => e.name)
    .sort();
}

export interface Wrapper {
  /** The wrapper file, repo-relative. */
  file: string;
  fm: Frontmatter;
}

/** Our skills and agents, with their frontmatter. */
export function ourEntries(root: string): Wrapper[] {
  const out: Wrapper[] = [];
  const skills = join(root, SKILLS);
  if (existsSync(skills))
    for (const e of readdirSync(skills, { withFileTypes: true }))
      if (e.isDirectory() && existsSync(join(skills, e.name, "SKILL.md"))) {
        const file = `${SKILLS}/${e.name}/SKILL.md`;
        out.push({ file, fm: frontmatter(readFileSync(join(root, file), "utf8")) });
      }
  const agents = join(root, CLAUDE_AGENTS);
  if (existsSync(agents))
    for (const e of readdirSync(agents, { withFileTypes: true }))
      if (e.isFile() && e.name.endsWith(".md")) {
        const file = `${CLAUDE_AGENTS}/${e.name}`;
        out.push({ file, fm: frontmatter(readFileSync(join(root, file), "utf8")) });
      }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Problems with the third-party copies, the wrappers and the Claude Code links.
 * An empty list is a pass.
 */
export function checkThirdParty(root: string): string[] {
  const problems: string[] = [];
  /** Upstream entry (repo-relative) → its description. */
  const entries = new Map<string, string>();
  const unwrapped = new Set<string>();

  for (const name of sourceNames(root)) {
    const dir = join(root, THIRD_PARTY, name);
    let src: Source;
    try {
      src = readSource(root, name);
    } catch (e) {
      problems.push(`${THIRD_PARTY}/${name}/${SOURCE_FILE}: unreadable (${(e as Error).message})`);
      continue;
    }
    for (const k of ["repo", "ref", "commit", "license"] as const)
      if (typeof src[k] !== "string" || !src[k])
        problems.push(`${THIRD_PARTY}/${name}: ${SOURCE_FILE} has no ${k}`);
    const onDisk = walk(dir).filter((p) => p !== SOURCE_FILE);
    const recorded = Object.keys(src.files ?? {}).sort();
    for (const p of onDisk)
      if (!(p in (src.files ?? {})))
        problems.push(
          `${THIRD_PARTY}/${name}/${p}: not from upstream (sync rewrites this directory)`,
        );
    for (const p of recorded) {
      const abs = join(dir, p);
      if (!existsSync(abs)) problems.push(`${THIRD_PARTY}/${name}/${p}: recorded, but missing`);
      else if (sha256(readFileSync(abs)) !== src.files[p])
        problems.push(
          `${THIRD_PARTY}/${name}/${p}: edited — third-party files are never changed here; amend in the wrapper`,
        );
    }
    for (const p of recorded)
      if ((src.wrap ?? []).some((g) => globMatch(g, p))) {
        const full = `${THIRD_PARTY}/${name}/${p}`;
        if (src.unwrapped?.[p]) unwrapped.add(full);
        else
          entries.set(
            full,
            frontmatter(readFileSync(join(dir, p), "utf8")).fields.description ?? "",
          );
      }
    for (const p of Object.keys(src.unwrapped ?? {}))
      if (!recorded.includes(p))
        problems.push(`${THIRD_PARTY}/${name}: unwrapped "${p}" is not a copied file`);
  }

  const claimed = new Map<string, string>();
  for (const w of ourEntries(root)) {
    const up = w.fm.metadata.upstream;
    if (!up) continue;
    if (unwrapped.has(up)) {
      problems.push(`${w.file}: wraps ${up}, which ${SOURCE_FILE} lists as unwrapped`);
      continue;
    }
    if (!entries.has(up)) {
      problems.push(`${w.file}: metadata.upstream ${up} is not an upstream entry`);
      continue;
    }
    const other = claimed.get(up);
    if (other) problems.push(`${up}: wrapped twice (${other}, ${w.file})`);
    claimed.set(up, w.file);
    const link = posix.relative(posix.dirname(w.file), up);
    if (!w.fm.body.includes(link))
      problems.push(`${w.file}: does not link to its upstream (${link})`);
    const own = w.fm.metadata["own-description"];
    if (!own && (w.fm.fields.description ?? "") !== entries.get(up))
      problems.push(
        `${w.file}: description differs from upstream's — copy it, or say why in metadata.own-description`,
      );
  }
  for (const up of entries.keys())
    if (!claimed.has(up))
      problems.push(
        `${up}: no wrapper (add one, or list it in ${SOURCE_FILE} unwrapped with a reason)`,
      );

  problems.push(...checkClaudeLinks(root));
  return problems;
}

/** `.claude/skills/<n>` is a symlink to `../../.agents/skills/<n>`, one per skill, and nothing else. */
export function checkClaudeLinks(root: string): string[] {
  const problems: string[] = [];
  const skills = existsSync(join(root, SKILLS))
    ? readdirSync(join(root, SKILLS), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const linked = existsSync(join(root, CLAUDE_SKILLS))
    ? readdirSync(join(root, CLAUDE_SKILLS))
    : [];
  for (const n of skills) {
    const link = join(root, CLAUDE_SKILLS, n);
    const want = skillLinkTarget(n);
    if (!linked.includes(n)) problems.push(`${CLAUDE_SKILLS}/${n}: missing (a symlink to ${want})`);
    else if (!lstatSync(link).isSymbolicLink())
      problems.push(`${CLAUDE_SKILLS}/${n}: not a symlink (skills live in ${SKILLS}/)`);
    else if (readlinkSync(link) !== want)
      problems.push(`${CLAUDE_SKILLS}/${n}: points at ${readlinkSync(link)}, not ${want}`);
  }
  for (const n of linked)
    if (!skills.includes(n))
      problems.push(`${CLAUDE_SKILLS}/${n}: no ${SKILLS}/${n} (skills live in ${SKILLS}/)`);
  return problems;
}

// ─── sync ──────────────────────────────────────────────────────────────────

export interface SyncOptions {
  ref?: string;
  repo?: string;
  paths?: string[];
  wrap?: string[];
  license?: string;
}

type Run = (cmd: string, args: string[], cwd?: string) => { code: number | null; out: string };

const realRun: Run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.error ? null : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/**
 * Re-copy one source from upstream. Returns the lines to print and an exit
 * code: 0 synced (or unchanged), 1 refused, 2 could not ask (no git, no network).
 */
export function sync(
  root: string,
  name: string,
  opts: SyncOptions = {},
  run: Run = realRun,
): { code: 0 | 1 | 2; lines: string[] } {
  const lines: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    return { code: 1, lines: [`"${name}": a source name is lowercase words joined by -`] };
  const dir = join(root, THIRD_PARTY, name);
  const existing = existsSync(join(dir, SOURCE_FILE)) ? readSource(root, name) : null;
  const repo = opts.repo ?? existing?.repo;
  const paths = opts.paths?.length ? opts.paths : existing?.paths;
  const wrap = opts.wrap?.length ? opts.wrap : existing?.wrap;
  const license = opts.license ?? existing?.license;
  const ref = opts.ref ?? existing?.ref ?? "HEAD";
  if (!repo || !paths?.length || !wrap || !license)
    return {
      code: 1,
      lines: [`${name}: a new source needs --repo, --path (one or more), --wrap and --license`],
    };

  const tmp = mkdtempSync(join(tmpdir(), `3rdparty-${name}-`));
  try {
    const clone = run("git", [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      repo,
      tmp,
    ]);
    if (clone.code !== 0)
      return { code: 2, lines: [`could not clone ${repo}: ${clone.out.trim()}`] };
    const co = run("git", ["checkout", "--quiet", ref], tmp);
    if (co.code !== 0) return { code: 2, lines: [`could not check out ${ref}: ${co.out.trim()}`] };
    const commit = run("git", ["rev-parse", "HEAD"], tmp).out.trim();

    if (existing?.commit === commit && !opts.paths && !opts.wrap) {
      lines.push(`${name}: unchanged at ${commit.slice(0, 12)} (${ref})`);
      return { code: 0, lines };
    }
    if (existing?.commit) {
      lines.push(`${name}: ${existing.commit.slice(0, 12)} → ${commit.slice(0, 12)} (${ref})`);
      const stat = run(
        "git",
        ["diff", "--stat", `${existing.commit}..${commit}`, "--", ...paths],
        tmp,
      );
      lines.push(stat.code === 0 ? stat.out.trimEnd() : `  (no diff: ${stat.out.trim()})`);
      const log = run(
        "git",
        ["log", "--oneline", "--no-decorate", `${existing.commit}..${commit}`, "--", ...paths],
        tmp,
      );
      if (log.code === 0 && log.out.trim()) lines.push("", "Upstream commits:", log.out.trimEnd());
    } else lines.push(`${name}: new, at ${commit.slice(0, 12)} (${ref})`);

    /** @type {Record<string, string>} */
    const files: Record<string, string> = {};
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const p of paths) {
      const from = join(tmp, p);
      if (!existsSync(from))
        return { code: 1, lines: [...lines, `${p}: not in ${repo} at ${ref}`] };
      const taken = p.endsWith("/") ? walk(from).map((f) => posix.join(p, f)) : [p];
      for (const f of taken) {
        if (lstatSync(join(tmp, f)).isSymbolicLink()) continue;
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        cpSync(join(tmp, f), join(dir, f));
        files[f] = sha256(readFileSync(join(dir, f)));
      }
    }
    const src: Source = {
      repo,
      ref,
      commit,
      license,
      paths,
      wrap,
      ...(existing?.unwrapped ? { unwrapped: existing.unwrapped } : {}),
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    };
    writeFileSync(join(dir, SOURCE_FILE), `${JSON.stringify(src, null, 2)}\n`);

    const changed = existing
      ? Object.keys(files).filter((f) => existing.files[f] !== files[f])
      : Object.keys(files);
    const gone = existing ? Object.keys(existing.files).filter((f) => !(f in files)) : [];
    const touched = new Set([...changed, ...gone].map((f) => `${THIRD_PARTY}/${name}/${f}`));
    const review = ourEntries(root).filter((w) => touched.has(w.fm.metadata.upstream ?? ""));
    if (review.length)
      lines.push(
        "",
        "Wrappers whose upstream changed (re-read the amendments against it):",
        ...review.map((w) => `  ${w.file}`),
      );
    const problems = checkThirdParty(root);
    if (problems.length) lines.push("", "check:", ...problems.map((p) => `  ${p}`));
    lines.push("", `wrote ${THIRD_PARTY}/${name}/ (${Object.keys(files).length} files)`);
    return { code: 0, lines };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function parse(argv: string[]) {
  const [cmd, name, ...rest] = argv;
  const opts: SyncOptions = {};
  const many = (k: "paths" | "wrap", v: string) => (opts[k] = [...(opts[k] ?? []), v]);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const v = rest[i + 1] ?? "";
    if (flag === "--ref") opts.ref = v;
    else if (flag === "--repo") opts.repo = v;
    else if (flag === "--license") opts.license = v;
    else if (flag === "--path") many("paths", v);
    else if (flag === "--wrap") many("wrap", v);
    else throw new Error(`unknown flag ${flag}`);
    i++;
  }
  return { cmd, name, opts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(import.meta.dirname, "..", "..");
  const { cmd, name, opts } = parse(process.argv.slice(2));
  if (cmd === "link") {
    const r = ensureSkillLinks(root);
    for (const l of r.created) console.log(`  linked   ${l}`);
    for (const l of r.removed) console.log(`  removed  ${l}`);
    for (const l of r.kept) console.log(`  kept     ${l} (not a link; the project's own)`);
    for (const l of r.failed) console.log(`  FAILED   ${l}`);
    process.exit(r.failed.length ? 1 : 0);
  } else if (cmd === "check") {
    const problems = checkThirdParty(root);
    for (const p of problems) console.log(`  ${p}`);
    console.log(problems.length ? `${problems.length} problem(s)` : "third-party: ok");
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === "sync" && name) {
    const r = sync(root, name, opts);
    for (const l of r.lines) console.log(l);
    process.exit(r.code);
  } else {
    console.error(
      "usage: third-party.mts check | sync <name> [--ref <ref>] [--repo … --path … --wrap … --license …]",
    );
    process.exit(1);
  }
}
