/**
 * A complete, valid configuration for tests to adjust. A partial object is no
 * longer a configuration — the loader refuses it — so a test that wants one
 * field different starts here and changes that field.
 */
import type { SdlcConfig } from "./config.mts";

export function exampleConfig(edit: (c: SdlcConfig) => void = () => {}): SdlcConfig {
  const c: SdlcConfig = {
    branches: { integration: "dev", staging: "staging", production: "main" },
    dirs: {
      requirements: "docs/requirements",
      plan: "docs/plan",
      progress: "docs/progress",
      adr: "docs/adr",
      handoffs: "docs/handoffs",
    },
    claimStaleDays: 7,
    cadence: { progressReportWeekdays: [1, 4], planSyncDays: 7 },
    accounts: [],
    ci: { steps: [] },
    coverage: { floors: {} },
  };
  edit(c);
  return c;
}

/** The same, as the text of an sdlc.config.json. */
export const exampleConfigJson = (edit?: (c: SdlcConfig) => void): string =>
  `${JSON.stringify(exampleConfig(edit), null, 2)}\n`;
