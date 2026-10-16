/**
 * Rewrite the evidence index after every run.
 *
 * Teardown rather than a command to remember, because an index that has to be
 * remembered goes stale — and a stale index of *what is tested* reads as
 * coverage nobody has. A subprocess, so the index runs as the plain-node CLI it
 * is rather than inside Playwright's module transform.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import type { FullConfig } from "@playwright/test";
import { INDEX_CLI } from "../cli/paths.mts";
import { journeysRoot } from "../config.mts";

export default function globalTeardown(full: FullConfig): void {
  const root = journeysRoot(full.configFile ? dirname(full.configFile) : process.cwd());
  const result = spawnSync(process.execPath, [INDEX_CLI], { cwd: root, stdio: "inherit" });
  if (result.status !== 0)
    console.warn(`journeys: the index did not regenerate (exit ${result.status ?? "signal"})`);
}
