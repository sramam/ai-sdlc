/**
 * PreToolUse: `docs/requirements/` is written only by a requirements skill.
 *
 * Requirements are what the code is checked against, so a change to them is a
 * deliberate act with its own branch and PR (docs/kit/hooks.md). The skills
 * that make that act — `kickoff`, `idea`, `add-requirement` — mark the session
 * by writing `<session_id> <skill>` to `.claude/requirements-session` in the
 * checkout being written. Anything else is refused.
 *
 *     docs/requirements/sources/**   refused, except Write creating a NEW file
 *                                    in a marked session — that is /idea
 *                                    importing a document. Edit, and Write over
 *                                    an existing source, are refused always:
 *                                    source material is immutable once there
 *     docs/requirements/sources/MANIFEST   refused, always — appended only by
 *                                    `sources-manifest.mts --add`, which records
 *                                    each import's sha256 (checked in ci)
 *     docs/requirements/**           allowed only for a marked session
 *     everything else                not this guard's business
 *
 * It marks who is authoring **in this checkout**; it does not lock across
 * agents — branches do that. Bash writes (`sed -i`) are not seen; the
 * `commit-msg` hook's `Requirements:` trailer is the backstop.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_FILE, loadConfig } from "../../core/src/config.mts";
import { canonical, checkoutRoot } from "../../core/src/git-command.mts";
import { denyOutput } from "./worktree-base.mts";

const NAMED_WRITE = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
export const SKILLS = ["kickoff", "idea", "add-requirement"] as const;
export const SESSION_FILE = ".claude/requirements-session";
export const DEFAULT_REQUIREMENTS_DIR = "docs/requirements";

export type HookInput = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string };
};

export type Verdict = { decision: "allow"; note?: string } | { decision: "deny"; reason: string };

export type Facts = {
  /** The top of the checkout the target is in. */
  root: string;
  /** Repo-relative, no trailing slash. */
  requirementsDir: string;
  /** Lines of `.claude/requirements-session` in that checkout; [] if absent. */
  marks: string[];
  /** Whether the target exists already. Only consulted under sources/. */
  exists?: boolean;
};

const ALLOW: Verdict = { decision: "allow" };

/** The skill this session is marked as running, or null. Empty ids never match. */
export function markedSkill(marks: string[], sessionId: string): string | null {
  if (!sessionId) return null;
  for (const line of marks) {
    const [id, skill] = line.trim().split(/\s+/);
    if (id && id === sessionId && skill && (SKILLS as readonly string[]).includes(skill)) {
      return skill;
    }
  }
  return null;
}

export function verdict(input: HookInput, facts: Facts): Verdict {
  if (!NAMED_WRITE.has(input.tool_name ?? "")) return ALLOW;
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!file) return ALLOW;

  const target = resolve(input.cwd || facts.root, file);
  const rel = relative(facts.root, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return ALLOW; // outside this checkout
  const path = rel.split(sep).join("/");

  const dir = facts.requirementsDir.replace(/\/+$/, "");
  if (!path.startsWith(`${dir}/`)) return ALLOW;

  const skill = markedSkill(facts.marks, input.session_id ?? "");

  if (path.startsWith(`${dir}/sources/`)) {
    const manifest = path === `${dir}/sources/MANIFEST`;
    const importing = !manifest && input.tool_name === "Write" && facts.exists === false;
    if (importing && skill)
      return {
        decision: "allow",
        note:
          `new source under a ${skill} session — record it: ` +
          `node tooling/guards/src/sources-manifest.mts --add ${path}`,
      };
    return {
      decision: "deny",
      reason: manifest
        ? `\`${dir}/sources/MANIFEST\` is appended only by ` +
          "`node tooling/guards/src/sources-manifest.mts --add <path>`, which records the " +
          "sha256 of a newly imported source."
        : `\`${dir}/sources/\` holds the source material requirements are derived from, ` +
          "and is never edited — by anyone, in any skill. A requirements skill " +
          "(/kickoff, /idea, /add-requirement) may import a **new** file there with Write" +
          (importing ? ", and this session is not marked as running one" : "") +
          "; to disagree with a source, record a requirement instead.",
    };
  }

  if (skill) return { decision: "allow", note: `requirements session: ${skill}` };

  return {
    decision: "deny",
    reason:
      `\`${dir}/\` is written only by a requirements skill — /kickoff, /idea or ` +
      "/add-requirement — which marks this session in " +
      `\`${SESSION_FILE}\` as \`<session_id> <skill>\`. This session is not marked` +
      (facts.marks.length ? " (the file names other sessions)" : "") +
      ". Run the skill rather than editing requirements directly; a requirements change " +
      "lands on its own branch and PR, before the code that depends on it.",
  };
}

export function readMarks(root: string): string[] {
  try {
    const path = join(root, SESSION_FILE);
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((l) => l.trim())
      : [];
  } catch {
    return [];
  }
}

/** `dirs.requirements` from `sdlc.config.json`; the default if it cannot be read. */
export async function requirementsDir(root: string): Promise<string> {
  try {
    if (!existsSync(join(root, CONFIG_FILE))) return DEFAULT_REQUIREMENTS_DIR;
    return (await loadConfig(root)).dirs?.requirements || DEFAULT_REQUIREMENTS_DIR;
  } catch {
    return DEFAULT_REQUIREMENTS_DIR;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (NAMED_WRITE.has(input.tool_name ?? "") && file) {
      const target = canonical(resolve(input.cwd || process.cwd(), file));
      // The checkout the write lands in — a worktree has its own marks file.
      // Could not ask (not a repository, no git) → allow.
      const root = checkoutRoot(target);
      if (root) {
        const result = verdict(
          { ...input, cwd: root, tool_input: { file_path: target } },
          {
            root,
            requirementsDir: await requirementsDir(root),
            marks: readMarks(root),
            exists: existsSync(target),
          },
        );
        if (result.decision === "deny") console.log(denyOutput(result.reason));
        else if (result.note) console.error(`requirements-lock: allowed — ${result.note}`);
      }
    }
  } catch {
    // Unreadable input: not ours to judge.
  }
  process.exit(0);
}
