/**
 * **StackAdapter: TanStack Start built for Workers, served by `wrangler dev`,
 * against this checkout's localdb through Hyperdrive's local connection string.**
 *
 * Instantiated as `e2e/stack.mts` and named by `journeys.config.mts`
 * (`adapter: "e2e/stack.mts"`). The constants below are the project's.
 *
 * | | |
 * | --- | --- |
 * | build | `vite build` — the BUILT Worker is what is recorded, never `vite dev` (no dev overlay, and the real bundle) |
 * | start | `db:local start`, then `wrangler dev` on the host's app port with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` set to the localdb URL |
 * | reset | `db:local reset --force`: snapshot, empty, migrate. The port is derived per checkout, so the URL wrangler holds stays valid |
 * | mail | the Worker prints `EMAIL-CAPTURE {json}` (it cannot write the host's disk); this adapter owns wrangler's output and appends each to the outbox |
 */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { appendCaptured } from "../tooling/journeys/src/outbox.mts";
import type { StackAdapter, StackEnv } from "../tooling/journeys/src/stack/host.mts";

const APP_DIR = "apps/web"; // the app, relative to the checkout
const DB = "app"; // its localdb database (sdlc.config.json localdb.databases[].name)
const BINDING = "HYPERDRIVE"; // its Hyperdrive binding (wrangler.jsonc)
const CAPTURE_MARKER = "EMAIL-CAPTURE "; // must match the app's src/server/mail.ts

/** Hyperdrive's local mode refuses a URL without a password; PGlite ignores it. */
export function withPassword(url: string): string {
  const u = new URL(url);
  if (!u.password) u.password = "localdb";
  return u.toString();
}

/** A captured message from one line of wrangler's output, or null. ANSI-tolerant. */
export function parseCapture(
  line: string,
): { to: string[]; subject: string; html: string; text: string } | null {
  const at = line.indexOf(CAPTURE_MARKER);
  if (at < 0) return null;
  // eslint-disable-next-line no-control-regex
  const json = line.slice(at + CAPTURE_MARKER.length).replace(/\x1b\[[0-9;]*m/g, "");
  const m = JSON.parse(json.slice(0, json.lastIndexOf("}") + 1)) as Record<string, unknown>;
  if (!Array.isArray(m.to) || typeof m.subject !== "string") return null;
  return {
    to: m.to.map(String),
    subject: m.subject,
    html: String(m.html ?? ""),
    text: String(m.text ?? ""),
  };
}

function dbLocal(checkout: string, ...args: string[]): string {
  const r = spawnSync("pnpm", ["-s", "db:local", ...args, DB], { cwd: checkout, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `STACK-001: db:local ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

let checkout = process.cwd();

const adapter: StackAdapter = {
  name: "tanstack-workers",
  readyPath: "/health",
  mode: { name: "wrangler dev (built Worker)", devOverlayPossible: false },

  async build() {
    const r = spawnSync("pnpm", ["exec", "vite", "build"], {
      cwd: join(checkout, APP_DIR),
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`vite build exited ${r.status}`);
  },

  async start(env: StackEnv) {
    checkout = env.checkout;
    dbLocal(checkout, "start");
    const url = withPassword(dbLocal(checkout, "url"));
    // Same process group — never `detached` (tooling/journeys/src/stack/host.mts).
    const child = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--config",
        "dist/server/wrangler.json",
        "--port",
        String(env.appPort),
        "--ip",
        "localhost",
        // Better Auth refuses an Origin that is not its baseURL.
        "--var",
        `BETTER_AUTH_URL:${env.appUrl}`,
        "--var",
        "EMAIL_TRANSPORT:capture",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: join(checkout, APP_DIR),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, [`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${BINDING}`]: url },
      },
    );
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        const mail = parseCapture(line);
        if (mail) appendCaptured(env.outboxDir, mail);
        else process.stderr.write(line + "\n");
      });
    }
    // The database outlives the run: db:local owns it, and reset reuses it.
    return { pid: child.pid, stop: async () => {} };
  },

  async reset() {
    dbLocal(checkout, "reset", "--force");
  },
};

export default adapter;
