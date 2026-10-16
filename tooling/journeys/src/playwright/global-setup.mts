/**
 * Where the suite's wall clock starts, for the index's *run took* line.
 *
 * The paths time themselves, but their sum is not how long the suite took. In
 * scratch: it belongs to one run, and the index consumes it on read so a hand
 * run hours later does not report the gap as a duration.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FullConfig } from "@playwright/test";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import { RUN_STAMP } from "./run-stamp.mts";

export default async function globalSetup(full: FullConfig): Promise<void> {
  const root = journeysRoot(full.configFile ? dirname(full.configFile) : process.cwd());
  const config = await loadJourneysConfig(root);
  const scratch = join(root, config.scratchRoot);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, RUN_STAMP), JSON.stringify({ startedAt: Date.now() }) + "\n");
}
