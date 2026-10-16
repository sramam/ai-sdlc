/**
 * `--journey J4 --persona organizer` → the spec files that are exactly that walk.
 *
 * ## Why Playwright's `--grep` cannot do this
 *
 * `--grep` is a regex over the title path, and two facts make it the wrong
 * instrument: **journey ids are prefixes of each other** (`--grep J2` records
 * J23), and **every persona of a journey shares one describe title**. A
 * learning run widened that way grows mask unions on walks nobody is reviewing
 * — three passes of it — which is a change nobody looked at.
 *
 * ## The filename carries both, and the census enforces it
 *
 * ```
 * e2e/j4-signing-in.organizer.spec.ts
 *     └── journey     └── persona
 * ```
 *
 * So this resolves to **paths**, which cannot be a prefix of another journey
 * the way `J2` is of `J23`. **A filter that matches nothing throws** rather than
 * running everything: a typo silently widening to the whole suite is also a
 * whole-suite re-record.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** `j4-signing-in.organizer.spec.ts` → its journey id and persona segment. */
export const SPEC_NAME = /^([a-z]+\d+)-([a-z0-9-]+)\.([a-z0-9-]+)\.spec\.(?:ts|mts)$/;

export function parseSpecName(
  file: string,
): { journey: string; slug: string; persona: string } | null {
  const m = SPEC_NAME.exec(file);
  return m ? { journey: m[1]!.toUpperCase(), slug: m[2]!, persona: m[3]! } : null;
}

export type Selection = {
  /** Spec paths to hand Playwright, relative to the root. */
  files: string[];
  /** Everything that was not ours, passed through untouched. */
  rest: string[];
  asked: { journey?: string; persona?: string };
};

/** Pull `--journey` and `--persona` out of `argv`, and resolve them against `specDir`. */
export function selectSpecs(argv: readonly string[], root: string, specDir: string): Selection {
  const rest: string[] = [];
  let journey: string | undefined;
  let persona: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--journey") journey = argv[++i]?.toUpperCase();
    else if (arg.startsWith("--journey=")) journey = arg.slice("--journey=".length).toUpperCase();
    else if (arg === "--persona") persona = argv[++i];
    else if (arg.startsWith("--persona=")) persona = arg.slice("--persona=".length);
    else rest.push(arg);
  }
  if (!journey && !persona) return { files: [], rest, asked: {} };

  const dir = join(root, specDir);
  const all = (existsSync(dir) ? readdirSync(dir) : [])
    .map((file) => ({ file, parts: parseSpecName(file) }))
    .filter(
      (x): x is { file: string; parts: NonNullable<ReturnType<typeof parseSpecName>> } => !!x.parts,
    );

  const files = all
    .filter((x) => !journey || x.parts.journey === journey)
    .filter((x) => !persona || x.parts.persona === persona)
    .map((x) => relative(root, join(dir, x.file)))
    .sort();

  if (files.length === 0) {
    const asked = [journey && `journey ${journey}`, persona && `persona ${persona}`]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `JOURNEY-060: no journey spec in ${specDir}/ matches ${asked}.\n` +
        `  Journeys: ${[...new Set(all.map((x) => x.parts.journey))].sort().join(" ") || "none"}\n` +
        `  Personas: ${[...new Set(all.map((x) => x.parts.persona))].sort().join(" ") || "none"}`,
    );
  }
  return {
    files,
    rest,
    asked: { ...(journey ? { journey } : {}), ...(persona ? { persona } : {}) },
  };
}
