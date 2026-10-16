import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Not vite.config.ts: the components are tested without the Tailwind plugin,
// because jsdom applies no stylesheet anyway (layout is checked in the browser).
export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
