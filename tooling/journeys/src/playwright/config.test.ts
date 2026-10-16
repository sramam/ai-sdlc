import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANAGED_BY_PLAYWRIGHT } from "../stack/scratch.mts";
import { APP_PORT_VAR, DB_PORT_VAR, EXTERNAL_VAR } from "../stack/urls.mts";
import { STACK_CLI, defineJourneyPlaywrightConfig } from "./config.mts";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

/** A config built without a real sweep: explicit ports, and the stack declared external. */
function build(external: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "journeys-pw-")));
  process.env[APP_PORT_VAR] = "4321";
  process.env[DB_PORT_VAR] = "5900";
  process.env.TEST_WORKER_INDEX = "0"; // inside a worker: the sweep is a no-op
  if (external) process.env[EXTERNAL_VAR] = "1";
  else delete process.env[EXTERNAL_VAR];
  return {
    root,
    config: defineJourneyPlaywrightConfig({ root, journeys: { scratchRoot: "scratch" } }),
  };
}

describe("defineJourneyPlaywrightConfig", () => {
  it("puts Playwright's output in the subdirectory the scratch sweep keeps", () => {
    const { root, config } = build(false);
    expect(config.outputDir).toBe(join(root, "scratch", MANAGED_BY_PLAYWRIGHT));
  });

  it("runs one worker, bounds actions, and starts the stack host as the web server", () => {
    const { config } = build(false);
    expect(config.workers).toBe(1);
    expect(config.use?.actionTimeout).toBe(30_000);
    expect(config.use?.baseURL).toBe("http://localhost:4321");
    const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    expect(server?.command).toContain(STACK_CLI);
    expect(process.env.JOURNEY_OUTBOX_DIR).toMatch(/scratch\/email-outbox$/);
    expect(process.env.JOURNEY_CONTROL_URL).toBe("http://127.0.0.1:5901");
  });

  it("brings no web server when somebody else owns the stack", () => {
    // `defineConfig` normalises an absent web server to an empty list.
    expect([build(true).config.webServer].flat().filter(Boolean)).toEqual([]);
  });
});
