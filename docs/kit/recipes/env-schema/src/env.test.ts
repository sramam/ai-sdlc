import { describe, expect, it } from "vitest";
import { envSchema } from "./env";

const base = {
  APP_ENV: "staging",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://staging.example.com",
  HYPERDRIVE: { connectionString: "postgres://a:b@h/d" },
};
const refused = (v: unknown) => {
  const r = envSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

describe("envSchema", () => {
  it("accepts a complete deployed environment", () => expect(refused(base)).toEqual([]));
  it("refuses capture outside local", () =>
    expect(refused({ ...base, EMAIL_TRANSPORT: "capture" })).toEqual(["EMAIL_TRANSPORT"]));
  it("allows capture locally", () =>
    expect(refused({ ...base, APP_ENV: "local", EMAIL_TRANSPORT: "capture" })).toEqual([]));
  it("names a missing binding", () =>
    expect(refused({ ...base, HYPERDRIVE: undefined })).toEqual(["HYPERDRIVE"]));
  it("refuses an undeclared environment", () =>
    expect(refused({ ...base, APP_ENV: "preview" })).toEqual(["APP_ENV"]));
});
