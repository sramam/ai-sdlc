/**
 * The project's knobs for the SDLC tooling. Edit this file, never tooling/.
 * Shape and meaning: tooling/core/src/config.mts and docs/kit/starter-repo.md.
 */
import { defineConfig } from "./tooling/core/src/config.mts";

export default defineConfig({
  branches: { integration: "dev", staging: "staging", production: "main" },
  dirs: {
    requirements: "docs/requirements",
    plan: "docs/plan",
    progress: "docs/progress",
    adr: "docs/adr",
    handoffs: "docs/handoffs",
  },
  claimStaleDays: 7,
  // 1 = Monday, 4 = Thursday
  cadence: { progressReportWeekdays: [1, 4], planSyncDays: 7 },
  accounts: [
    { name: "GitHub", cli: "gh", check: ["auth", "status", "--active"] },
    { name: "Cloudflare", cli: "wrangler", check: ["whoami"] },
    // Added by /kickoff as vendors are decided, e.g.
    // { name: "Neon", cli: "neonctl", check: ["me", "--output", "json"] },
    // { name: "Lovable", cli: null, check: [], manual: "owner signs in at lovable.dev" },
  ],
  ci: {
    steps: [
      { name: "plan:check", run: "node tooling/plan/src/plan-check.mts", applies: "always" },
      { name: "trailers", run: "node tooling/guards/src/trailers.mts --range", applies: "always" },
      { name: "lint", run: "pnpm run lint", applies: "always" },
      { name: "typecheck", run: "pnpm run typecheck", applies: "always" },
      { name: "unit", run: "pnpm run test", applies: "always" },
      { name: "format", run: "pnpm run format:check", applies: "always" },
      { name: "audit", run: "pnpm audit --prod --audit-level high", applies: "has-packages" },
      // Added by the foundation items: build, smoke, contract, coverage, journeys, secret scan.
    ],
  },
  coverage: { floors: {} },
  // Modules (tooling/<name>) this project has replaced with its own; sdlc:update skips them.
  modules: { replaced: [] },
});
