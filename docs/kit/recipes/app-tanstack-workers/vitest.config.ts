import { defineConfig } from "vitest/config";

// A config of its own: without it vitest loads vite.config.ts, and with it the
// Cloudflare plugin (it reads .dev.vars). The port and its helpers are plain Node.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], environment: "node" },
});
