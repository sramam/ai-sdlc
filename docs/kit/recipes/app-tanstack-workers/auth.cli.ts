// For `pnpm dlx auth@latest generate --config auth.cli.ts --output src/db/auth-schema.ts`
// only: an instance with no live connection.
import { drizzle } from "drizzle-orm/node-postgres";
import { createAuth } from "./src/auth";

export const auth = createAuth(drizzle.mock(), {
  secret: "schema-generation-only-".padEnd(32, "x"),
  baseURL: "http://localhost",
  sendOtp: async () => {},
});
