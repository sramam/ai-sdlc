/**
 * **Which journeys exist, what they are called, and who walks them.**
 *
 * door_nexa kept this in `scripts/journeys.mts`, a 1,459-line map that the
 * delivery plan, the board sync and the recorder all read. Here it is the
 * project's to declare, in `journeys.config.mts` (`registry`) or in a module of
 * its own (`registryFile`), and this file is what everything else asks.
 *
 * **The registry is the only spelling of a title that counts.** The evidence
 * folder is `<id>-<slug(title)>`, so a spec that typed its own title and got it
 * slightly wrong would write a **second directory** beside the real one, and
 * every disk-derived index would report the old recording for ever. So the
 * recorder checks the spec's title against this and throws on a disagreement
 * with both spellings in the message (`assertTitle`).
 *
 * **`common` is a persona key every journey may use**, for a walk that does not
 * depend on who performs it — a wrong code, an expired link. It is a
 * declaration rather than a default: filing a refusal under one role makes that
 * role's walk look larger than it is, which is how door_nexa came to add it.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const COMMON = "common";

export type RegisteredJourney = {
  /** `J4`, and the folder prefix. Append-only: a number means nothing but when it was thought of. */
  id: string;
  title: string;
  /** The persona keys that may perform it. A second *directory* means a second walk was recorded. */
  personas: string[];
};

export type Registry = {
  journeys: RegisteredJourney[];
  /** Every persona key, with the label a pointer page prints. */
  personas: Record<string, { label: string }>;
};

export const EMPTY_REGISTRY: Registry = { journeys: [], personas: {} };

/** The folder-name form of a title — the recorder's, the census's and the index's. */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `J4-signing-in`. The id is kept as written: lowercasing it writes a second folder. */
export const journeyFolder = (id: string, title: string): string => `${id}-${slug(title)}`;

export function findJourney(registry: Registry, id: string): RegisteredJourney | undefined {
  return registry.journeys.find((j) => j.id === id);
}

/**
 * Refuse a title that is not the registry's.
 *
 * Checked rather than looked up, so a spec still reads as prose — and a
 * disagreement throws with both spellings rather than silently preferring one.
 */
export function assertTitle(registry: Registry, id: string, title: string): RegisteredJourney {
  const known = findJourney(registry, id);
  if (!known) {
    throw new Error(
      `JOURNEY-020: ${id} is not in the journey registry — add it with /journey-add first ` +
        `(registry in journeys.config.mts)`,
    );
  }
  if (known.title !== title) {
    throw new Error(
      `JOURNEY-021: ${id} is "${known.title}" in the registry, not "${title}". ` +
        "The registry is the source; a second spelling writes a second folder.",
    );
  }
  return known;
}

/**
 * Refuse a persona this journey does not declare.
 *
 * A walk recorded under a persona the registry does not list is either a typo —
 * which writes a directory nothing reads — or a journey whose registration is
 * out of date. Both are cheaper to name here than in a census later.
 */
export function assertPersona(
  registry: Registry,
  journey: RegisteredJourney,
  persona: string,
): void {
  if (persona === COMMON) return;
  if (!registry.personas[persona]) {
    throw new Error(
      `JOURNEY-022: "${persona}" is not a persona in the registry. Known: ` +
        `${[...Object.keys(registry.personas), COMMON].sort().join(", ")}`,
    );
  }
  if (!journey.personas.includes(persona)) {
    throw new Error(
      `JOURNEY-023: ${journey.id} does not list "${persona}" among its personas ` +
        `(${journey.personas.join(", ") || "none"}). Register the walk before recording it.`,
    );
  }
}

/** The label a pointer page prints for a persona key. */
export function personaLabel(registry: Registry, key: string): string {
  if (key === COMMON) return "Anybody — what follows does not depend on who performs it";
  return registry.personas[key]?.label ?? key;
}

/**
 * Refuse a registry that would fail later and somewhere else: a duplicate id,
 * a persona no entry declares, a title that slugs to nothing.
 */
export function validateRegistry(registry: Registry): void {
  const fail = (what: string) => {
    throw new Error(`JOURNEY-024: journey registry: ${what}`);
  };
  const seen = new Set<string>();
  for (const j of registry.journeys) {
    if (!/^[A-Za-z]+\d+$/.test(j.id)) fail(`id "${j.id}" is not a prefix and a number`);
    if (seen.has(j.id)) fail(`${j.id} is declared twice`);
    seen.add(j.id);
    if (!slug(j.title))
      fail(`${j.id}'s title "${j.title}" has no letters or digits to name a folder`);
    for (const p of j.personas) {
      if (p !== COMMON && !registry.personas[p])
        fail(`${j.id} names persona "${p}", which is not declared`);
    }
  }
  if (registry.personas[COMMON]) fail(`"${COMMON}" is reserved — it is not a persona to declare`);
}

/**
 * Load a registry from a module path, relative to `root`.
 *
 * Either export shape: `export default { journeys, personas }` or a named
 * `registry`. A module that has neither is refused rather than read as empty —
 * an empty registry makes every recording an orphan, which reads as the census
 * being broken.
 */
export async function loadRegistryFile(file: string, root: string): Promise<Registry> {
  const path = isAbsolute(file) ? file : join(root, file);
  if (!existsSync(path)) throw new Error(`JOURNEY-025: registryFile ${path} does not exist`);
  const mod = (await import(pathToFileURL(path).href)) as {
    default?: Registry;
    registry?: Registry;
  };
  const registry = mod.registry ?? mod.default;
  if (!registry || !Array.isArray(registry.journeys)) {
    throw new Error(
      `JOURNEY-025: ${path} exports no registry — write \`export const registry = { journeys, personas }\``,
    );
  }
  validateRegistry(registry);
  return registry;
}
