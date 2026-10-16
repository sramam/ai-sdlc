/**
 * Where this package's CLIs are, by absolute path — what Playwright's
 * `webServer`, the learner, the teardown and the `journeys` bin spawn. Spawned
 * as `node <path>` so each command line carries its own name, which is what the
 * load gate's `pgrep -f` matches (`DEFAULT_RECORDING_PROCESSES`).
 */
import { fileURLToPath } from "node:url";

const cli = (name: string): string => fileURLToPath(new URL(`./${name}.mts`, import.meta.url));

export const STACK_CLI = cli("stack");
export const LEARN_CLI = cli("learn");
export const DELTA_CLI = cli("delta");
export const INDEX_CLI = cli("index");
