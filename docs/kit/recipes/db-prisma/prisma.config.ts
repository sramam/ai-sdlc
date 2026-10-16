import { defineConfig } from "prisma/config";

// DATABASE_URL comes from `pnpm db:local migrate` locally, and from the promote
// script (the environment's DIRECT, non-Hyperdrive URL) when deployed.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
