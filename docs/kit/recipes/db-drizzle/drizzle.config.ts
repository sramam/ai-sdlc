import { defineConfig } from "drizzle-kit";

// DATABASE_URL is set by `pnpm db:local migrate` (localdb) locally, and by the
// promote script (the environment's DIRECT, non-Hyperdrive URL) when deployed.
// `generate` reads only the schema; everything else needs a database.
const url = process.env.DATABASE_URL ?? "";
if (!url && !process.argv.includes("generate")) {
  throw new Error("DB-001: DATABASE_URL is not set — run through `pnpm db:local migrate`");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
