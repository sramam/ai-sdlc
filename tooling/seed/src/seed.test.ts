import { describe, expect, it } from "vitest";
import { result, scriptedExec } from "../../core/src/exec.mts";
import type { SdlcConfig } from "../../core/src/config.mts";
import { databaseUrl } from "../../localdb/src/lib.mts";
import { CAPTURE_ENV, main, plan } from "./seed.mts";
import type { DbAnswer, PlanInput } from "./seed.mts";

const LOCAL = databaseUrl(55001);
const running: DbAnswer = { state: "running", url: LOCAL, port: 55001, env: ["HYPERDRIVE_LOCAL"] };

const base: PlanInput = {
  seeds: [
    { app: "web", run: "seed-web", database: "app" },
    { app: "admin", run: "seed-admin", sizes: ["dev", "demo"] },
  ],
  apps: [],
  size: "dev",
  target: "local",
  today: "2026-10-15",
  random: "ai-sdlc",
  envUrl: undefined,
  databases: { app: running },
  localPorts: [55001],
};

describe("plan: the allow-list", () => {
  it("local with a running localdb passes its URL, to the extra variables too", () => {
    const { plans, refusals } = plan(base);
    expect(refusals).toEqual([]);
    const web = plans.find((p) => p.app.app === "web")!;
    expect(web.env).toMatchObject({
      DATABASE_URL: LOCAL,
      HYPERDRIVE_LOCAL: LOCAL,
      SEED_SIZE: "dev",
      SEED_RANDOM: "ai-sdlc",
      SEED_TODAY: "2026-10-15",
      SEED_TARGET: "local",
      ...CAPTURE_ENV,
    });
    expect(plans.find((p) => p.app.app === "admin")!.env.DATABASE_URL).toBeUndefined();
  });

  for (const target of ["production", "prod", "preview", ""]) {
    it(`refuses target ${JSON.stringify(target)}`, () => {
      const r = plan({ ...base, target, envUrl: "postgresql://u@prod.example.com/db" });
      expect(r.refusals).toHaveLength(1); // the target, and nothing that follows from it
      expect(r.refusals[0]).toMatch(/not one seeds may write to/);
      expect(r.plans).toEqual([]);
    });
  }

  it("refuses a DATABASE_URL that is not this checkout's localdb, with target local", () => {
    const r = plan({ ...base, seeds: [base.seeds[1]!], envUrl: "postgresql://u@db.neon.tech/x" });
    expect(r.refusals.join()).toMatch(/not one of this checkout's running localdb/);
    const loopbackButNotOurs = plan({
      ...base,
      seeds: [base.seeds[1]!],
      envUrl: databaseUrl(5432),
    });
    expect(loopbackButNotOurs.refusals).toHaveLength(1);
    const ours = plan({ ...base, seeds: [base.seeds[1]!], envUrl: LOCAL });
    expect(ours.refusals).toEqual([]);
    // Refused even for an app whose own localdb would have replaced it.
    expect(plan({ ...base, envUrl: "postgresql://u@db.neon.tech/x" }).refusals).toHaveLength(1);
  });

  it("refuses a stopped localdb and names the command that starts it", () => {
    const r = plan({
      ...base,
      databases: { app: { state: "stopped", reason: "not running" } },
      localPorts: [],
    });
    expect(r.refusals.join()).toMatch(/pnpm db:local start app/);
  });

  it("refuses an app nobody declared, naming the configured ones", () => {
    expect(plan({ ...base, apps: ["mobile"] }).refusals.join()).toMatch(
      /"mobile" declares no seed data — configured: web, admin/,
    );
  });

  it("refuses a size the app does not declare", () => {
    expect(plan({ ...base, size: "test" }).refusals.join()).toMatch(
      /admin: no size "test" — it declares dev, demo/,
    );
  });

  it("dev and staging take DATABASE_URL from the environment, and refuse a localdb one", () => {
    const remote = "postgresql://u@dev.example.com/db";
    expect(plan({ ...base, target: "dev", envUrl: remote }).plans[0]!.env.DATABASE_URL).toBe(
      remote,
    );
    expect(plan({ ...base, target: "staging" }).refusals.join()).toMatch(/needs DATABASE_URL/);
    expect(plan({ ...base, target: "dev", envUrl: LOCAL }).refusals.join()).toMatch(
      /say --target local/,
    );
  });

  it("refuses a today that is not a date", () => {
    expect(plan({ ...base, today: "15/10/2026" }).refusals.join()).toMatch(/YYYY-MM-DD/);
  });
});

describe("main", () => {
  const log: string[] = [];
  const deps = (config: Partial<SdlcConfig>, exec = scriptedExec([[/^sh -c /, result(0)]])) => ({
    root: "/repo",
    config: config as SdlcConfig,
    exec,
    log: (l: string) => log.push(l),
    env: { PATH: "/bin", EMAIL_TRANSPORT: "resend" } as NodeJS.ProcessEnv,
    ask: async (): Promise<DbAnswer> => running,
  });

  it("with no seeds configured says so and exits 0", async () => {
    expect(await main([], deps({}))).toBe(0);
    expect(log.at(-1)).toMatch(/^no application declares seed data/);
  });

  it("runs each app with the forced capture transports and prints a line with its duration", async () => {
    const exec = scriptedExec([[/^sh -c /, result(0)]]);
    const d = deps({ seeds: base.seeds, localdb: { databases: [{ name: "app" }] } }, exec);
    expect(await main(["--size", "demo", "--today", "2026-01-31", "web"], d)).toBe(0);
    expect(exec.calls).toHaveLength(1);
    const env = exec.calls[0]!.opts.env!;
    expect(env.EMAIL_TRANSPORT).toBe("capture");
    expect(env.SEED_TODAY).toBe("2026-01-31");
    expect(env.DATABASE_URL).toBe(LOCAL);
    expect(log.at(-1)).toMatch(/^ok {4}web {2}size demo {2}target local {2}localdb app {2}\d/);
  });

  it("refuses before running anything, and a failing seeder fails the run", async () => {
    const exec = scriptedExec([[/^sh -c /, result(2)]]);
    expect(await main(["--target", "production"], deps({ seeds: base.seeds }, exec))).toBe(1);
    expect(exec.calls).toHaveLength(0);
    expect(
      await main(
        ["web"],
        deps({ seeds: base.seeds, localdb: { databases: [{ name: "app" }] } }, exec),
      ),
    ).toBe(1);
    expect(log.at(-1)).toMatch(/^FAIL {2}web .*exit 2/);
  });
});
