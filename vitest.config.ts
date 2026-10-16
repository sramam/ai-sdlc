import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest's 5s default is scenery, not a check: no test here asserts speed.
    // Several do real work (PNG diffs, PGlite servers, Chromium) and crossed 5s
    // only under full parallel load (one pixel-delta test at 5021ms). Bounded,
    // not removed, so genuine slowness still fails (docs/kit/principles.md §13).
    testTimeout: 20_000,
    include: [
      "tooling/**/*.test.{ts,mts}",
      "scripts/**/*.test.{ts,mts}",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      // The project's journey specs live in e2e/; their unit tests (an
      // adapter's, say) run here like any other.
      "e2e/**/*.test.{ts,mts}",
    ],
    // Other agents' worktrees live inside the repo; never collect their tests.
    exclude: ["**/node_modules/**", "**/.claude/worktrees/**", "scripts/one-of/**"],
  },
});
