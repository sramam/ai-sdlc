/**
 * **What the evidence held before a learning run, so an abort puts all of it
 * back** — screenshots, masks, narratives, `run.json`, captured files and the
 * index, not the masks alone.
 *
 * A learning run writes into the committed evidence tree as it goes: pass 1
 * replaces a reference that does not match, pass 2 unions boxes into masks, and
 * every pass rewrites the narrative and the index. When the run then cannot
 * reach pass 3 — the host would not reset, the stack died, somebody pressed
 * Ctrl-C — what was written is half a recording: a new reference with no
 * verification behind it, sitting where the next comparison will trust it.
 * door_nexa's version put back the masks and told the operator to
 * `git restore` the rest, which nobody does at 6pm.
 *
 * ## Why a copy and a restore, rather than recording into a staging tree
 *
 * Staging the whole run elsewhere and renaming it into place after pass 3 is
 * the stronger shape, and it would mean teaching the recorder, the index, the
 * census and every reader that the evidence lives somewhere else for the
 * duration of a run — each a place to get the path wrong. This is one module
 * and two calls in the learner, and it gives the same guarantee for every
 * abort the learner can see: **the committed evidence is as it was**. A
 * `SIGKILL` of the learner itself is the case it cannot cover; git can.
 *
 * Scope is the journey folders a run can touch — one journey's when the run
 * names one, every journey's otherwise — plus the files at the evidence root,
 * because the teardown rewrites the index after every pass. A folder created
 * by the run is removed on restore, the way `restoreMasks` removes a mask the
 * bad pass created.
 */
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { idOf, journeyFolders } from "../evidence-tree.mts";

export type Undone = { reverted: string[]; removed: string[] };

export type EvidenceBackup = {
  /** Put the in-scope evidence back exactly as it was, and say what that undid. */
  restore(): Undone;
  /** The run was verified: drop the copy. */
  discard(): void;
};

/** Journey folders and root-level files in scope, by name. */
function inScope(evidence: string, journey: string | undefined): string[] {
  if (!existsSync(evidence)) return [];
  const folders = journeyFolders(evidence).filter((f) => !journey || idOf(f) === journey);
  const files = readdirSync(evidence, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  return [...folders, ...files].sort();
}

/** A fingerprint of a file or tree: relative paths and contents. */
function fingerprint(path: string): string {
  const hash = createHash("sha256");
  const walk = (at: string, rel: string): void => {
    if (statSync(at).isDirectory()) {
      hash.update(`d:${rel}\0`);
      for (const entry of readdirSync(at).sort()) walk(join(at, entry), `${rel}/${entry}`);
    } else {
      hash.update(`f:${rel}\0`);
      hash.update(readFileSync(at));
    }
  };
  walk(path, "");
  return hash.digest("hex");
}

/** Move `from` to `to`, copying when they are on different filesystems. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Copy the in-scope evidence into `backupDir` (copy-on-write where the
 * filesystem offers it). Throws if the copy cannot be made: a learning run
 * that could not be undone must not start.
 */
export function backupEvidence(
  evidence: string,
  backupDir: string,
  journey?: string,
): EvidenceBackup {
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(backupDir, { recursive: true });
  const before = inScope(evidence, journey);
  for (const name of before) {
    cpSync(join(evidence, name), join(backupDir, name), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  }

  let settled = false;
  return {
    restore(): Undone {
      if (settled) return { reverted: [], removed: [] };
      settled = true;
      const reverted: string[] = [];
      const removed: string[] = [];
      for (const name of inScope(evidence, journey)) {
        if (before.includes(name)) continue;
        rmSync(join(evidence, name), { recursive: true, force: true });
        removed.push(name);
      }
      mkdirSync(evidence, { recursive: true });
      for (const name of before) {
        const here = join(evidence, name);
        const kept = join(backupDir, name);
        if (existsSync(here) && fingerprint(here) === fingerprint(kept)) continue;
        rmSync(here, { recursive: true, force: true });
        move(kept, here);
        reverted.push(name);
      }
      rmSync(backupDir, { recursive: true, force: true });
      return { reverted: reverted.sort(), removed: removed.sort() };
    },
    discard(): void {
      if (settled) return;
      settled = true;
      rmSync(backupDir, { recursive: true, force: true });
    },
  };
}

/** Under scratch: the next stack's sweep removes a copy an abort left behind. */
export const BACKUP_DIR = "evidence-before-learn";

/** What a restore undid, as lines for a refusal. */
export function putBack(undone: Undone, evidenceRoot: string): string {
  return [
    `  Evidence put back as it was before pass 1: ${undone.reverted.length} restored, ${undone.removed.length} removed` +
      ` (screenshots, masks, narratives and the index under ${evidenceRoot}/)`,
    ...undone.reverted.map((f) => `    restored  ${f}`),
    ...undone.removed.map((f) => `    removed   ${f}`),
    "",
  ].join("\n");
}
