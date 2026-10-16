import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tooling/**/*.test.{ts,mts}",
      "scripts/**/*.test.{ts,mts}",
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    // Other agents' worktrees live inside the repo; never collect their tests.
    exclude: ["**/node_modules/**", "**/.claude/worktrees/**", "scripts/one-of/**"],
  },
});
