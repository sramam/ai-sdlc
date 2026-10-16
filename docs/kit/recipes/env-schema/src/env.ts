// Variables AND bindings, one schema, validated once per isolate and failing
// loudly with the name of everything missing. Runtime-free: the binding passes
// `env` in (src/server/env.ts reads it from `cloudflare:workers`).
import { z } from "zod";

/** Structural, so the schema runs in Node tests with a plain object. */
const hyperdrive = z.custom<{ connectionString: string }>(
  (v) =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { connectionString?: unknown }).connectionString === "string",
  "a Hyperdrive binding — declare `hyperdrive` for this environment in wrangler.jsonc",
);

/** Allow-list: an environment not named here is refused, never defaulted. */
export const APP_ENVS = ["local", "dev", "staging", "production"] as const;

export const envSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVS),
    BETTER_AUTH_SECRET: z.string().min(32, "at least 32 characters — `openssl rand -base64 32`"),
    BETTER_AUTH_URL: z.url(),
    EMAIL_TRANSPORT: z.enum(["capture", "resend"]).default("resend"),
    HYPERDRIVE: hyperdrive,
  })
  .superRefine((env, ctx) => {
    // Named where it applies (local), never where it does not.
    if (env.EMAIL_TRANSPORT === "capture" && env.APP_ENV !== "local") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_TRANSPORT"],
        message: `capture is refused on ${env.APP_ENV}`,
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

export function parseEnv(raw: unknown): AppEnv {
  if (cached) return cached;
  const r = envSchema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`ENV-001: the Worker's environment is invalid:\n${lines.join("\n")}`);
  }
  return (cached = r.data);
}
