/* eslint-disable no-console -- a CLI prints on purpose */
/**
 * `pnpm dev:session [email] [--url <app url>] [--out <dir>]`
 *
 * Signs a seeded account in to a running app (local or dev) and writes a
 * cookie jar for curl and a storageState for Playwright:
 *
 *   curl -b .dev-session/<email>.cookies.txt http://127.0.0.1:8787/api/auth/get-session
 *
 * Instantiate as `scripts/dev-session.mts`. It reads, from `.dev.vars`/`.env`
 * through tooling's loadEnv: APP_ENV (local | dev, nothing else), BETTER_AUTH_URL,
 * BETTER_AUTH_SECRET, and DATABASE_URL (the DIRECT database the app's Hyperdrive
 * points at: `pnpm -s db:local url` locally, the dev branch's direct URL on dev).
 *
 * The secret and the database are what make the code readable, which is why
 * this needs nothing a developer holding `.dev.vars` does not already hold.
 * Add `.dev-session/` to .gitignore: the files are live sessions.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadEnv } from "../tooling/setup/src/load-env.mts";
// The app's generated Better Auth tables (db-drizzle recipe): imports drizzle only.
import * as authSchema from "../apps/web/src/db/auth-schema.ts";
import { curlJar, devSignIn, envVerdict, storageState } from "./dev-session/dev-session.ts";

loadEnv();
const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const email = (
  args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "admin@example.test"
).toLowerCase();
const baseUrl = flag("--url") ?? process.env.BETTER_AUTH_URL ?? "";
const outDir = flag("--out") ?? ".dev-session";

const fail = (code: string, detail: string): never => {
  console.error(`${code}: ${detail}`);
  process.exit(1);
};

const verdict = envVerdict(process.env.APP_ENV, baseUrl);
if (!verdict.ok) fail(verdict.code, verdict.detail);
const secret =
  process.env.BETTER_AUTH_SECRET ?? fail("DEVSESSION-009", "BETTER_AUTH_SECRET is not set");
const databaseUrl =
  process.env.DATABASE_URL ??
  fail("DEVSESSION-009", "DATABASE_URL is not set (pnpm -s db:local url)");

const client = new pg.Client({ connectionString: databaseUrl });
await client
  .connect()
  .catch((e: unknown) => fail("DEVSESSION-010", `could not reach the database: ${String(e)}`));
try {
  const db = drizzle(client);
  // Only for reading the code back. It MUST match the app's createAuth on what
  // decides storage (secret, storeOTP), or the code it decrypts is not the app's.
  const auth = betterAuth({
    secret,
    baseURL: baseUrl,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    plugins: [emailOTP({ storeOTP: "encrypted", sendVerificationOTP: async () => {} })],
  });

  const r = await devSignIn({
    baseUrl,
    email,
    fetch: (url, init) => fetch(url, init),
    readOtp: async (e) =>
      (await auth.api.getVerificationOTP({ query: { email: e, type: "sign-in" } })).otp ?? null,
    userExists: async (e) =>
      (
        await db
          .select({ id: authSchema.user.id })
          .from(authSchema.user)
          .where(eq(authSchema.user.email, e))
      ).length > 0,
  });
  if (!r.ok) fail(r.code, r.detail);
  if (r.ok) {
    mkdirSync(outDir, { recursive: true });
    const jar = join(outDir, `${email}.cookies.txt`);
    const state = join(outDir, `${email}.storage.json`);
    writeFileSync(jar, curlJar(r.cookies, baseUrl), { mode: 0o600 });
    writeFileSync(state, JSON.stringify(storageState(r.cookies, baseUrl), null, 2), {
      mode: 0o600,
    });
    console.log(`signed in ${r.user.email} (${process.env.APP_ENV}) at ${baseUrl}`);
    console.log(`  curl:       curl -b ${jar} ${baseUrl}/api/auth/get-session`);
    console.log(`  playwright: browser.newContext({ storageState: "${state}" })`);
  }
} finally {
  await client.end();
}
