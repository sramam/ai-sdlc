import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Any tool that globs from the root must skip other agents' worktrees and
    // throwaway scripts (docs/kit/multi-agent.md).
    ignores: [
      "**/node_modules/**",
      "**/.claude/worktrees/**",
      "scripts/one-of/**",
      "**/dist/**",
      "coverage/**",
      ".ci-local/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mts,tsx}"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Telemetry is structured (docs/kit/observability.md). Scripts print on purpose.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["tooling/**", "scripts/**"],
    rules: { "no-console": "off" },
  },
);
