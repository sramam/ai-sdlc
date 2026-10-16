/**
 * `journeys stack` — run the app under test for a recording, until signalled.
 *
 * What Playwright's `webServer` spawns (see `playwright/config.mts`) and what
 * `journeys learn` spawns once for its three passes. It loads the project's
 * adapter — `adapter` in `journeys.config.mts`, a module whose default export
 * implements `StackAdapter` and whose optional named `seed` implements
 * `SeedAdapter` — and hands it to `startHost`, which builds, sweeps scratch,
 * starts, seeds, opens the control channel and waits for ready.
 *
 * Once ready it writes `stack.json` into scratch (`stack/stamp.mts`), which is
 * how the learner knows *this* stack is up and how a recorder in a test worker
 * knows which stack it photographed.
 */
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { journeysRoot, loadJourneysConfig } from "../config.mts";
import { startHost, stopOnSignals } from "../stack/host.mts";
import { processStarted } from "../stack/ownership.mts";
import { listenerPids } from "../stack/ports.mts";
import type { SeedAdapter, StackAdapter } from "../stack/host.mts";
import { writeStackStamp } from "../stack/stamp.mts";
import { freeStackPorts, resolveStackUrls } from "../stack/urls.mts";

export async function loadAdapter(
  module: string | undefined,
  root: string,
): Promise<{ adapter: StackAdapter; seed?: SeedAdapter }> {
  if (!module) {
    throw new Error(
      "JOURNEY-013: journeys.config.mts names no `adapter`, so there is no app to start. " +
        "Write a module whose default export implements StackAdapter (tooling/journeys/src/stack/host.mts).",
    );
  }
  const path = isAbsolute(module) ? module : join(root, module);
  const mod = (await import(pathToFileURL(path).href)) as {
    default?: StackAdapter;
    seed?: SeedAdapter;
  };
  const adapter = mod.default;
  if (!adapter || typeof adapter.start !== "function" || typeof adapter.reset !== "function") {
    throw new Error(
      `JOURNEY-013: ${path} has no default export implementing StackAdapter (start, reset, readyPath, mode)`,
    );
  }
  return { adapter, ...(mod.seed ? { seed: mod.seed } : {}) };
}

async function main(): Promise<void> {
  const root = journeysRoot();
  const config = await loadJourneysConfig(root);
  const { adapter, seed } = await loadAdapter(config.adapter, root);
  const urls = resolveStackUrls({
    cwd: root,
    ports: config.ports,
    scratchRoot: config.scratchRoot,
  });
  freeStackPorts(urls, { scratchDir: join(root, config.scratchRoot), marker: config.ports.marker });

  const nonce = randomBytes(16).toString("hex");
  const host = await startHost({
    adapter,
    ...(seed ? { seed } : {}),
    urls,
    scratchRoot: config.scratchRoot,
    scratchKeep: config.scratchKeep,
    nonce,
  });
  /*
   * Who holds this stack's ports, recorded while it is known to be ours: the
   * only evidence a later sweep accepts before it kills a listener here.
   */
  const owned = [urls.appPort, urls.dbPort, urls.controlPort].flatMap((port) =>
    listenerPids(port).flatMap((pid) => {
      const started = processStarted(pid);
      return started ? [{ pid, port, started }] : [];
    }),
  );
  writeStackStamp(join(root, config.scratchRoot), {
    name: adapter.mode.name,
    devOverlayPossible: adapter.mode.devOverlayPossible,
    pid: process.pid,
    readyAt: Date.now(),
    nonce,
    controlUrl: urls.controlUrl,
    owned,
  });
  stopOnSignals(host);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
