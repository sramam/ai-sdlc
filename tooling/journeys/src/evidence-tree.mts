/**
 * **The evidence root, as data**: every journey folder, every persona
 * directory, every recorded path — read from disk, the one place that cannot
 * disagree with itself.
 *
 * The layout the recorder writes, and every reader expects:
 *
 * ```
 * <evidenceRoot>/<id>-<slug(title)>/<persona>/<path>/
 *     README.md  diff.md  run.json  snapshots/  files/
 * ```
 *
 * **A persona directory is marked by `persona.json`**, never recognised by its
 * name or by an absence. A discriminator that works by absence gets a wrong
 * answer from any folder that is merely half-written. A path found directly
 * under a journey folder — door_nexa's layout before the persona level was
 * unconditional — is still enumerated, with no persona, so the pattern check can name
 * it rather than the walk silently skipping it.
 *
 * **Walked, never assumed to a fixed depth.** door_nexa's learner scanned two
 * levels and found `0 of 0 steps` the day the persona level arrived — and
 * reported *every recorded step is now compared* while comparing nothing.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PERSONA_MARKER, readPersonaMarker } from "./recorder/evidence.mts";

export type RecordedPath = {
  /** `J4-signing-in`. */
  journeyFolder: string;
  /** `J4` — the folder's prefix up to the first `-`. */
  id: string;
  /** The persona directory, or undefined for a path straight under the journey. */
  persona?: string;
  /** `happy`, `wrong-code`. */
  path: string;
  /** Absolute. */
  dir: string;
  /** `J4-signing-in/common/wrong-code` — how a recording is addressed. */
  rel: string;
};

const dirs = (at: string): string[] =>
  existsSync(at)
    ? readdirSync(at, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];

/** A directory is a recorded path if the recorder has written anything that only a path holds. */
const isPath = (dir: string): boolean =>
  ["README.md", "run.json", "snapshots"].some((f) => existsSync(join(dir, f)));

export const isPersonaDir = (dir: string): boolean => existsSync(join(dir, PERSONA_MARKER));

/** Journey folders under the evidence root: directories named `<id>-…`. */
export function journeyFolders(evidenceRoot: string): string[] {
  return dirs(evidenceRoot).filter((d) => /^[A-Za-z]+\d+-/.test(d));
}

export const idOf = (folder: string): string => folder.split("-")[0]!;

/** Every recorded path, in a stable order. */
export function recordedPaths(evidenceRoot: string): RecordedPath[] {
  const out: RecordedPath[] = [];
  for (const journeyFolder of journeyFolders(evidenceRoot)) {
    const journeyDir = join(evidenceRoot, journeyFolder);
    const id = idOf(journeyFolder);
    for (const child of dirs(journeyDir)) {
      const childDir = join(journeyDir, child);
      if (isPersonaDir(childDir)) {
        for (const path of dirs(childDir)) {
          const dir = join(childDir, path);
          if (!isPath(dir)) continue;
          out.push({
            journeyFolder,
            id,
            persona: child,
            path,
            dir,
            rel: `${journeyFolder}/${child}/${path}`,
          });
        }
      } else if (isPath(childDir)) {
        out.push({
          journeyFolder,
          id,
          path: child,
          dir: childDir,
          rel: `${journeyFolder}/${child}`,
        });
      }
    }
  }
  return out;
}

/** The persona directories of one journey folder, with their markers. */
export function personaDirs(
  journeyDir: string,
): Array<{ dir: string; key: string; label: string }> {
  return dirs(journeyDir)
    .map((d) => ({ d, marker: readPersonaMarker(join(journeyDir, d)) }))
    .filter((x) => x.marker !== null)
    .map((x) => ({ dir: x.d, key: x.marker!.key, label: x.marker!.label }));
}
