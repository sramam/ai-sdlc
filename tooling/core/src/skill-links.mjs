// @ts-check
/**
 * Skills live in `.agents/skills/<name>/`, where every agent harness that reads
 * that convention finds them. Claude Code reads `.claude/skills/` only, and
 * follows a symlinked skill directory, so each skill gets
 * `.claude/skills/<name>` → `../../.agents/skills/<name>`.
 *
 * The links are derived, never listed: `init`, `add` and `update` call
 * `ensureSkillLinks` after copying, and it creates what is missing and removes
 * links whose skill is gone. A real directory or file in `.claude/skills/` is
 * the project's own and is left alone (and reported).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export const AGENT_SKILLS = ".agents/skills";
export const CLAUDE_SKILLS = ".claude/skills";

/** @param {string} name */
export const skillLinkTarget = (name) => `../../${AGENT_SKILLS}/${name}`;

/**
 * @param {string} root the project root
 * @returns {{ created: string[], removed: string[], kept: string[], failed: string[] }}
 */
export function ensureSkillLinks(root) {
  /** @type {{ created: string[], removed: string[], kept: string[], failed: string[] }} */
  const out = { created: [], removed: [], kept: [], failed: [] };
  const skillsDir = join(root, AGENT_SKILLS);
  const linkDir = join(root, CLAUDE_SKILLS);
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  if (skills.length) mkdirSync(linkDir, { recursive: true });
  for (const n of skills) {
    const link = join(linkDir, n);
    const want = skillLinkTarget(n);
    /** @type {import("node:fs").Stats | null} */
    let st = null;
    try {
      st = lstatSync(link);
    } catch {
      st = null;
    }
    // An empty directory is what `update` leaves after removing a skill that
    // used to live here; it is nobody's, so the link replaces it.
    if (st?.isDirectory() && readdirSync(link).length === 0) {
      rmdirSync(link);
      st = null;
    }
    if (st && !st.isSymbolicLink()) {
      out.kept.push(`${CLAUDE_SKILLS}/${n}`);
      continue;
    }
    if (st && readlinkSync(link) === want) continue;
    try {
      if (st) unlinkSync(link);
      symlinkSync(want, link, "dir");
      out.created.push(`${CLAUDE_SKILLS}/${n}`);
    } catch (e) {
      out.failed.push(`${CLAUDE_SKILLS}/${n}: ${/** @type {Error} */ (e).message}`);
    }
  }
  if (existsSync(linkDir))
    for (const n of readdirSync(linkDir)) {
      const link = join(linkDir, n);
      if (skills.includes(n)) continue;
      const st = lstatSync(link);
      if (st.isSymbolicLink()) {
        if (readlinkSync(link) !== skillLinkTarget(n)) continue;
        unlinkSync(link);
      } else if (st.isDirectory() && readdirSync(link).length === 0) {
        // left empty by `update` removing a retired skill's files
        rmdirSync(link);
      } else continue;
      out.removed.push(`${CLAUDE_SKILLS}/${n}`);
    }
  return out;
}
