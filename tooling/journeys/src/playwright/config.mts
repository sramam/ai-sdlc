/**
 * **The Playwright config a journey suite needs, with every lesson in it.**
 *
 * ```ts
 * // playwright.config.ts
 * import { defineJourneyPlaywrightConfig } from "./tooling/journeys/src/playwright/config.mts";
 * import journeys from "./journeys.config.mts";
 * export default defineJourneyPlaywrightConfig({ journeys, root: import.meta.dirname });
 * ```
 *
 * | | | |
 * | --- | --- | --- |
 * | `workers: 1` | everywhere | door_nexa's flake lived where it was hardest to read: CI was serial and laptops fanned out. A deterministic suite that takes longer beats a fast one that fails one run in three (#549) |
 * | `outputDir` | `<scratch>/playwright` | Playwright **deletes** its output directory at the start of every run; when it was all of scratch it wiped the database the run was about to use, reported as `58P01 could not open file` |
 * | `webServer` | `journeys stack`, unless `JOURNEY_DB_EXTERNAL` | the learner brings one stack for three passes; three stacks in a row raced each other's shutdown for ports |
 * | ports swept at load | `freeStackPorts` | an orphan from a killed run holds the port and the next run dies with `EADDRINUSE`. It kills only this checkout's, and never inside a worker or when the stack is external |
 * | `actionTimeout: 30s` | | unset is *infinite*: a stuck click hangs to the test budget and the error then names the next await rather than the click (#755) |
 * | `testMatch` | `*.spec.{ts,mts}` | `.test.ts` is vitest's; Playwright's default takes both and loads a unit test into a browser run |
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import type { PlaywrightTestConfig } from "@playwright/test";
import { resolveJourneysConfig } from "../config.mts";
import type { JourneysConfigInput } from "../config.mts";
import { STACK_CLI } from "../cli/paths.mts";
import { OUTBOX_VAR } from "../outbox.mts";
import { MANAGED_BY_PLAYWRIGHT } from "../stack/scratch.mts";
import { EXTERNAL_VAR, freeStackPorts, resolveStackUrls } from "../stack/urls.mts";

const HERE = dirname(fileURLToPath(import.meta.url));

export { STACK_CLI };

export const OBJECTS_VAR = "JOURNEY_OBJECT_DIR";
export const CONTROL_VAR = "JOURNEY_CONTROL_URL";

export type JourneyPlaywrightOptions = {
  /** The repository root. Default: the working directory. */
  root?: string;
  /** The project's `journeys.config.mts` default export. */
  journeys?: JourneysConfigInput;
  /** What `webServer` polls. The adapter's `readyPath` is the stack's own, stricter check. */
  readyPath?: string;
  /** How long the stack may take to build, start and seed. door_nexa: 180s. */
  webServerTimeoutMs?: number;
  /** Merged last, so a project can override anything here — and say why beside it. */
  overrides?: PlaywrightTestConfig;
};

export function defineJourneyPlaywrightConfig(
  options: JourneyPlaywrightOptions = {},
): PlaywrightTestConfig {
  const root = options.root ?? process.cwd();
  const config = resolveJourneysConfig(options.journeys);
  const urls = resolveStackUrls({
    cwd: root,
    ports: config.ports,
    scratchRoot: config.scratchRoot,
  });

  /*
   * Pinned before any worker starts, so the tests read the outbox the app
   * writes. A worker looking at a different directory reports a broken sign-in
   * rather than a misconfigured path.
   */
  process.env[OUTBOX_VAR] = urls.outboxDir;
  process.env[OBJECTS_VAR] = urls.objectDir;
  process.env[CONTROL_VAR] = urls.controlUrl;

  // Before Playwright checks `webServer.url`. A no-op in a worker and when the
  // stack is somebody else's.
  freeStackPorts(urls);

  const base: PlaywrightTestConfig = {
    testDir: join(root, config.specDir),
    testMatch: "**/*.spec.{ts,mts}",
    outputDir: join(root, config.scratchRoot, MANAGED_BY_PLAYWRIGHT),
    globalSetup: join(HERE, "global-setup.mts"),
    globalTeardown: join(HERE, "global-teardown.mts"),
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    workers: 1,
    reporter: "list",
    use: {
      baseURL: urls.appUrl,
      trace: "retain-on-failure",
      actionTimeout: 30_000,
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    ...(process.env[EXTERNAL_VAR]
      ? {}
      : {
          webServer: {
            command: `node ${JSON.stringify(STACK_CLI)}`,
            url: `${urls.appUrl}${options.readyPath ?? "/"}`,
            cwd: root,
            reuseExistingServer: false,
            timeout: options.webServerTimeoutMs ?? 180_000,
          },
        }),
  };
  return defineConfig(base, options.overrides ?? {});
}
