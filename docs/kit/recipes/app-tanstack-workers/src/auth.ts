// Better Auth with email OTP. Built per request (its database is per request),
// and free of `cloudflare:` imports so the schema CLI can load it in Node.
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Db } from "./db/client";
import * as authSchema from "./db/auth-schema";

export type AuthOptions = {
  secret: string;
  baseURL: string;
  sendOtp: (email: string, otp: string) => Promise<void>;
};

export function createAuth(db: Db, opts: AuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    plugins: [
      emailOTP({
        // Encrypted, not hashed: a six-digit code brute-forces from a hash instantly.
        storeOTP: "encrypted",
        sendVerificationOTP: ({ email, otp }) => opts.sendOtp(email, otp),
      }),
    ],
  });
}
