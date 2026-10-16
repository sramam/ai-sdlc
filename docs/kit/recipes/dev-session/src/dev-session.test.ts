// Against a real Better Auth (email OTP, encrypted storage, the Drizzle adapter)
// over a real Postgres (PGlite), in process: the app's HTTP surface is
// `auth.handler`, so the whole sign-in runs with no server and no network.
import { PGlite } from "@electric-sql/pglite";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { beforeAll, describe, expect, it } from "vitest";
import * as authSchema from "../../db-drizzle/src/auth-schema";
import { curlJar, devSignIn, envVerdict, storageState, type DevSessionDeps } from "./dev-session";

const BASE = "http://127.0.0.1:3100";
let auth: ReturnType<typeof makeAuth>;
let db: ReturnType<typeof drizzle>;
const mailed: string[] = [];

// The same options as app-tanstack-workers/src/auth.ts, plus one: Better Auth
// 1.7 turns its origin check OFF when it detects a test runner (`isTest()` in
// create-context), so a suite asserting it would pass for the wrong reason.
function makeAuth(d: ReturnType<typeof drizzle>) {
  return betterAuth({
    secret: "dev-session-test-secret-".padEnd(32, "x"),
    baseURL: BASE,
    advanced: { disableOriginCheck: false },
    database: drizzleAdapter(d, { provider: "pg", schema: authSchema }),
    plugins: [
      emailOTP({
        storeOTP: "encrypted",
        sendVerificationOTP: async ({ email }) => void mailed.push(email),
      }),
    ],
  });
}

beforeAll(async () => {
  const pg = new PGlite();
  // The tables from the db-drizzle recipe's generated auth schema (setup, not a migration).
  const sql = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(authSchema));
  for (const statement of sql) await pg.exec(statement);
  db = drizzle(pg);
  auth = makeAuth(db);
  await db
    .insert(authSchema.user)
    .values({ id: "u-seeded", name: "Seeded", email: "seeded@example.test" });
});

const deps = (over: Partial<DevSessionDeps> = {}): DevSessionDeps => ({
  baseUrl: BASE,
  email: "seeded@example.test",
  fetch: (url, init) => auth.handler(new Request(url, init)),
  readOtp: async (email) =>
    (await auth.api.getVerificationOTP({ query: { email, type: "sign-in" } })).otp ?? null,
  userExists: async (email) =>
    (await db.select().from(authSchema.user).where(eq(authSchema.user.email, email))).length > 0,
  ...over,
});

describe("devSignIn", () => {
  it("completes a real sign-in for a seeded account, and the session works", async () => {
    const r = await devSignIn(deps());
    if (!r.ok) throw new Error(r.detail);
    expect(r.user).toEqual({ id: "u-seeded", email: "seeded@example.test" });
    const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = await auth.handler(
      new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }),
    );
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
      "seeded@example.test",
    );
    expect(curlJar(r.cookies, BASE)).toMatch(
      /^#HttpOnly_127\.0\.0\.1\tFALSE\t\/\tFALSE\t0\tbetter-auth\.session_token\t/m,
    );
    expect(storageState(r.cookies, BASE).cookies[0]).toMatchObject({
      domain: "127.0.0.1",
      httpOnly: true,
    });
  });

  it("refuses an address with no account, and creates none", async () => {
    const r = await devSignIn(deps({ email: "stranger@example.test" }));
    expect(r).toMatchObject({ ok: false, code: "DEVSESSION-004" });
    const rows = await db
      .select()
      .from(authSchema.user)
      .where(eq(authSchema.user.email, "stranger@example.test"));
    expect(rows).toEqual([]);
  });

  it("the code reader is server-only: over HTTP it is not reachable", async () => {
    const res = await auth.handler(
      new Request(
        `${BASE}/api/auth/email-otp/get-verification-otp?email=seeded@example.test&type=sign-in`,
      ),
    );
    expect(res.status).toBe(404);
  });

  it("Better Auth refuses a foreign Origin, and a missing one once cookies are sent", async () => {
    const post = (headers: Record<string, string>) =>
      auth.handler(
        new Request(`${BASE}/api/auth/email-otp/send-verification-otp`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ email: "seeded@example.test", type: "sign-in" }),
        }),
      );
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    const missing = await post({ cookie: "x=1" });
    expect(missing.status).toBe(403);
    expect(await missing.text()).toContain("MISSING_OR_NULL_ORIGIN");
  });
});

describe("envVerdict", () => {
  it.each([
    [undefined, BASE, "DEVSESSION-001"],
    ["production", BASE, "DEVSESSION-002"],
    ["staging", BASE, "DEVSESSION-002"],
    ["prod", BASE, "DEVSESSION-002"],
    ["local", "https://app.example.com", "DEVSESSION-003"],
  ])("APP_ENV=%s at %s is refused (%s)", (env, url, code) => {
    expect(envVerdict(env, url)).toMatchObject({ ok: false, code });
  });
  it.each([
    ["local", "http://localhost:3100"],
    ["dev", "https://app-dev.example.workers.dev"],
  ])("APP_ENV=%s at %s is allowed", (env, url) => {
    expect(envVerdict(env, url)).toEqual({ ok: true });
  });
});
