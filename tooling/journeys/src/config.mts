/**
 * The journeys module's own configuration, and where it is read from.
 *
 * **A file of its own, `journeys.config.mts` at the repository root**, rather
 * than a `journeys` key in `sdlc.config.json`. That key would be the natural home
 * and is the long-term one, but `SdlcConfig` lives in `tooling/core`, part of
 * base and outside this module — adding a field there is a change to every
 * project's config type, not this module's to make in passing. A separate
 * file costs one more file at the root and nothing else: absent, every default
 * below applies; present, it overrides field by field. Moving it under
 * `sdlc.config.json` later is a loader change here and a one-line move in a project.
 *
 * Every default was paid for — see the comments on the constants they come
 * from.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findRoot } from "../../core/src/config.mts";
import { DATE_SHAPES, DECLARED_VOLATILE } from "./mask/dom.mts";
import type { DeclaredVolatile } from "./mask/dom.mts";
import { DEFAULT_RECORDING_PROCESSES } from "./stack/load-gate.mts";
import { DEFAULT_PORT_PLAN } from "./stack/ports.mts";
import type { PortPlan } from "./stack/ports.mts";
import { DEFAULT_SETTLE } from "./recorder/settle-config.mts";
import type { SettleConfig } from "./recorder/settle-config.mts";
import { EMPTY_REGISTRY, loadRegistryFile, validateRegistry } from "./registry.mts";
import type { Registry } from "./registry.mts";
import { DEFAULT_ROUTES } from "./routes/adapter.mts";
import type { RoutesConfig } from "./routes/adapter.mts";
import { MANAGED_BY_PLAYWRIGHT } from "./stack/scratch.mts";

/**
 * Where reports a run writes beside the evidence — the delta, the timing log —
 * relative to the checkout. Under scratch, so nothing has to be gitignored, and
 * kept by the sweep (`scratchKeep`), so a timing history survives the next stack.
 */
export const REPORTS = "journey-reports";

export const CONFIG_FILE = "journeys.config.mts";

export interface JourneysConfig {
  /** Where recordings — screenshots, masks, narratives — are committed. */
  evidenceRoot: string;
  /** Per-run scratch, relative to the checkout. Swept at the start of a stack, never the end. */
  scratchRoot: string;
  /** Entries under `scratchRoot` another tool manages, which the sweep leaves alone. */
  scratchKeep: string[];
  /** The port band and the checkout marker — see `PortPlan`. */
  ports: PortPlan;
  /** Selectors whose elements are masked without being learned. Adding one is a decision. */
  declaredVolatile: DeclaredVolatile[];
  /** Regex sources for the dates this product prints; every one must be masked. */
  dateShapes: string[];
  /** `pgrep -f` substrings meaning another checkout is recording. */
  recordingProcessNames: string[];
  /** Literal journey-id prefixes; empty keeps "any one letter" (`J31`, `P1`). */
  idPrefixes: string[];
  /**
   * The app under test: a module whose default export implements
   * `StackAdapter` (`src/stack/host.mts`), and optionally a named `seed`
   * export implementing `SeedAdapter`. Relative to the root. Required by the
   * stack host, and by nothing that only reads evidence.
   */
  adapter?: string;
  /** Which journeys exist — declared inline. See `registry.mts`. */
  registry: Registry;
  /** …or in a module of its own (`export const registry = …`), relative to the root. Wins over `registry`. */
  registryFile?: string;
  /** What "the page has arrived" means for this app — see `recorder/settle.mts`. */
  settle: SettleConfig;
  /** Which router renders which file, for `journeys drift` — see `routes/adapter.mts`. */
  routes: RoutesConfig;
  /** The ref drift is measured against. */
  driftBase: string;
  /** Where the journey specs live: `<id>-<slug>.<persona>.spec.ts`. */
  specDir: string;
  /** The Playwright config the CLIs run, relative to the root. */
  playwrightConfig: string;
  /** Reports (delta, timing), relative to the checkout. Outside the evidence root, deliberately. */
  reportRoot: string;
  /** Where `pdfjs-dist` is resolved from, relative to the root — it is an optional peer. */
  pdfjsFrom: string[];
}

/** What a project writes: any subset, each field replacing the default whole. */
export type JourneysConfigInput = Partial<Omit<JourneysConfig, "ports" | "settle">> & {
  ports?: Partial<PortPlan>;
  settle?: Partial<SettleConfig>;
};

export const DEFAULT_JOURNEYS_CONFIG: JourneysConfig = {
  evidenceRoot: "docs/journeys",
  scratchRoot: "test-results",
  scratchKeep: [MANAGED_BY_PLAYWRIGHT, REPORTS],
  ports: { ...DEFAULT_PORT_PLAN },
  declaredVolatile: [...DECLARED_VOLATILE],
  dateShapes: [...DATE_SHAPES],
  recordingProcessNames: [...DEFAULT_RECORDING_PROCESSES],
  idPrefixes: [],
  registry: EMPTY_REGISTRY,
  settle: { ...DEFAULT_SETTLE },
  routes: DEFAULT_ROUTES,
  driftBase: "origin/dev",
  specDir: "e2e",
  playwrightConfig: "playwright.config.ts",
  reportRoot: `test-results/${REPORTS}`,
  pdfjsFrom: ["."],
};

/** The identity function that gives `journeys.config.mts` its types. */
export function defineJourneysConfig(config: JourneysConfigInput): JourneysConfigInput {
  return config;
}

/**
 * Defaults, overridden field by field. Lists **replace** rather than append: a
 * project that wants the default declared selectors plus one of its own spreads
 * `DECLARED_VOLATILE` itself, so the file says what is masked rather than
 * leaving half of it implied.
 */
export function resolveJourneysConfig(input: JourneysConfigInput = {}): JourneysConfig {
  const config: JourneysConfig = {
    ...DEFAULT_JOURNEYS_CONFIG,
    ...input,
    ports: { ...DEFAULT_JOURNEYS_CONFIG.ports, ...input.ports },
    settle: { ...DEFAULT_JOURNEYS_CONFIG.settle, ...input.settle },
  };
  validate(config);
  return config;
}

/**
 * Refuse a configuration that would fail later and somewhere else.
 *
 * A date shape that does not compile throws inside `page.evaluate`, in a browser,
 * mid-recording; a zero-slot band divides by zero in `portSlot`. Both are cheaper
 * to name here, with the field that caused them.
 */
function validate(config: JourneysConfig): void {
  const fail = (what: string) => {
    throw new Error(`JOURNEYS-CONFIG-001: ${CONFIG_FILE}: ${what}`);
  };
  const { appBase, dbBase, slots, marker } = config.ports;
  for (const [name, port] of [
    ["ports.appBase", appBase],
    ["ports.dbBase", dbBase],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${name} is not a port: ${port}`);
  }
  if (!Number.isInteger(slots) || slots < 1) fail(`ports.slots must be a positive integer`);
  if (dbBase + slots * 2 > 65535 || appBase + slots > 65535) {
    fail(`ports band runs past 65535 (appBase ${appBase}, dbBase ${dbBase}, slots ${slots})`);
  }
  if (!marker) fail("ports.marker is empty, so every directory would be a checkout");
  for (const source of config.dateShapes) {
    try {
      new RegExp(source, "g");
    } catch (error) {
      fail(`dateShapes entry does not compile: ${source} (${String(error)})`);
    }
  }
  validateRegistry(config.registry);
  for (const entry of config.settle.selectors) {
    if (typeof entry.until === "object" && "text" in entry.until) {
      try {
        new RegExp(entry.until.text);
      } catch (error) {
        fail(`settle.selectors ${entry.selector}: until.text does not compile (${String(error)})`);
      }
    }
  }
  for (const entry of config.declaredVolatile) {
    if (!entry.selector || !entry.why) {
      fail("every declaredVolatile entry needs a selector and a why — adding one is a decision");
    }
  }
}

/**
 * Read `journeys.config.mts` from the repository root, or answer the defaults.
 *
 * The root is the directory holding `sdlc.config.json` (`findRoot`), falling back
 * to `start` itself so the module works in a repository that has not adopted
 * the starter's config yet. The file's default export is the input.
 */
export async function loadJourneysConfig(start: string = process.cwd()): Promise<JourneysConfig> {
  const root = findRoot(start) ?? start;
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return resolveJourneysConfig();
  const mod = (await import(pathToFileURL(file).href)) as { default?: JourneysConfigInput };
  if (!mod.default) {
    throw new Error(
      `JOURNEYS-CONFIG-002: ${file} has no default export — write ` +
        "`export default defineJourneysConfig({ … })`",
    );
  }
  const config = resolveJourneysConfig(mod.default);
  if (config.registryFile) config.registry = await loadRegistryFile(config.registryFile, root);
  return config;
}

/** The repository root `loadJourneysConfig` reads from — every relative path in the config is under it. */
export function journeysRoot(start: string = process.cwd()): string {
  return findRoot(start) ?? start;
}
