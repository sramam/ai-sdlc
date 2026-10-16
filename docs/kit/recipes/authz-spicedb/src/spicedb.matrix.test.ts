// The policy matrix against a real SpiceDB (`serve-testing`, in memory) whose
// relationships arrive through the outbox from a real Postgres (PGlite).
// Without SpiceDB the matrix FAILS with AUTHZ-COULD-NOT-RUN (test-ci.mts maps that
// to exit 2), never passes; only AUTHZ_ENGINE=skip skips it, with a banner.
// The engine-free cases always run.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { CATALOGUE, spicedbAuthz, type SpiceDbConfig } from "./spicedb";
import {
  enqueue,
  membershipRelationship,
  pendingCount,
  projectRelationships,
  relay,
} from "./outbox";
import { WORLD, callerFor, checkCases, listCases, parseAccessModel } from "./matrix";
import { COULD_NOT_RUN, engineState, skipBanner } from "./could-not-run";

const SPICEDB_URL = process.env.SPICEDB_URL ?? "http://127.0.0.1:8443";
const here = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const rows = parseAccessModel(here("access-model.example.md"));

// serve-testing gives each bearer token its own empty datastore, so a fresh token is a fresh engine.
const reachable = await fetch(`${SPICEDB_URL}/v1/schema/read`, {
  method: "POST",
  headers: { authorization: `Bearer probe-${randomUUID()}` },
  body: "{}",
  signal: AbortSignal.timeout(1000),
})
  .then(() => true)
  .catch(() => false);

async function freshEngine(): Promise<SpiceDbConfig> {
  const config = { url: SPICEDB_URL, token: `test-${randomUUID()}` };
  const r = await fetch(`${SPICEDB_URL}/v1/schema/write`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ schema: here("schema.zed") }),
  });
  if (!r.ok) throw new Error(`schema refused (${r.status}): ${await r.text()}`);
  return config;
}

async function outboxDb() {
  const pg = new PGlite();
  await pg.exec(`
    create table authz_outbox (
      id serial primary key, op text not null,
      resource_type text not null, resource_id text not null, relation text not null,
      subject_type text not null, subject_id text not null,
      created_at timestamptz not null default now(), relayed_at timestamptz,
      zed_token text, attempts integer not null default 0, last_error text
    );`);
  return drizzle(pg);
}

const state = engineState(reachable);

if (state === "unreachable") {
  // Fails, so the suite cannot pass; test-ci.mts reports it as exit 2 (could not run).
  describe("spicedb matrix", () => {
    it(`${COULD_NOT_RUN}: no SpiceDB HTTP gateway at ${SPICEDB_URL} (README § Run the tests)`, () => {
      throw new Error(
        `${COULD_NOT_RUN}: no SpiceDB HTTP gateway at ${SPICEDB_URL}. Start it (README § Run the tests), or set AUTHZ_ENGINE=skip to opt out loudly.`,
      );
    });
  });
} else if (state === "skipped") {
  console.warn(skipBanner("SpiceDB"));
  describe("spicedb matrix", () => {
    it.skip("SKIPPED by AUTHZ_ENGINE=skip: the SpiceDB matrix was not run", () => {});
  });
} else {
  describe("spicedb matrix", () => {
    let config: SpiceDbConfig;

    beforeAll(async () => {
      config = await freshEngine();
      const db = await outboxDb();
      // The world arrives the way production data does: rows' relationships, through the outbox.
      await db.transaction(async (tx) => {
        await enqueue(tx, WORLD.memberships.map(membershipRelationship));
        await enqueue(tx, WORLD.projects.flatMap(projectRelationships));
      });
      const r = await relay(db, config);
      expect(r).toMatchObject({ ok: true, relayed: 9 });
    });

    it.each(checkCases(rows))("$name", async (c) => {
      const d = await spicedbAuthz(config).authorize(callerFor(c.persona), c.action, c.resource);
      expect(d.ok, JSON.stringify(d)).toBe(c.allowed);
      if (!d.ok) expect(d.code).toBe("FORBIDDEN");
    });

    it.each(listCases(rows))("$name", async (c) => {
      const f = await spicedbAuthz(config).listFilter(callerFor(c.persona), c.action, "Project");
      if (!f.ok || f.kind !== "ids") throw new Error(JSON.stringify(f));
      expect(f.ids.filter((id) => id !== "p-b").sort()).toEqual(c.visibleInA);
    });
  });

  describe("spicedb: against the engine", () => {
    it("a row's relationships are invisible until relayed, then visible; relaying twice is harmless", async () => {
      const config = await freshEngine();
      const db = await outboxDb();
      const admin = callerFor("admin");
      await db.transaction(async (tx) => {
        await enqueue(tx, [membershipRelationship(WORLD.memberships[0])]);
        await enqueue(
          tx,
          projectRelationships({ id: "p-new", orgId: "org-a", createdBy: "u-admin" }),
        );
      });
      const authz = spicedbAuthz(config);
      const target = { type: "Project", id: "p-new" };
      expect((await authz.authorize(admin, "project.read", target)).ok).toBe(false);
      const first = await relay(db, config);
      expect(first).toMatchObject({ ok: true, relayed: 3 });
      expect((await authz.authorize(admin, "project.read", target)).ok).toBe(true);
      expect(await relay(db, config)).toMatchObject({ ok: true, relayed: 0 });
    });

    it("an engine with no schema loaded is UNAVAILABLE, not a refusal that looks like policy", async () => {
      const authz = spicedbAuthz({ url: SPICEDB_URL, token: `empty-${randomUUID()}` });
      const d = await authz.authorize(callerFor("admin"), "project.read", {
        type: "Project",
        id: "p",
      });
      expect(d).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    });
  });
}

// No engine needed: these run whatever the engine's state.
describe("spicedb: outbox, default deny, could-not-ask", () => {
  it("a relay that cannot reach SpiceDB keeps the rows pending and records why", async () => {
    const db = await outboxDb();
    await db.transaction((tx) => enqueue(tx, [membershipRelationship(WORLD.memberships[0])]));
    const r = await relay(db, { url: "http://127.0.0.1:9", token: "x", timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(await pendingCount(db)).toBe(1);
  });

  it("every action in the catalogue appears in the access model, and vice versa", () => {
    const declared = Object.entries(CATALOGUE).flatMap(([t, as]) => as.map((a) => `${t}:${a}`));
    expect(declared.sort()).toEqual(rows.map((r) => `${r.resource}:${r.capability}`).sort());
  });

  it("refuses an unknown action or type before asking the engine", async () => {
    let asked = 0;
    const authz = spicedbAuthz({
      url: SPICEDB_URL,
      token: "x",
      fetch: async (...a) => (asked++, fetch(...a)),
    });
    const admin = callerFor("admin");
    expect(
      await authz.authorize(admin, "project.nuke", { type: "Project", id: "p" }),
    ).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await authz.listFilter(admin, "project.read", "Invoice")).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(asked).toBe(0);
  });

  it("an unreachable engine is UNAVAILABLE, never allowed", async () => {
    const authz = spicedbAuthz({ url: "http://127.0.0.1:9", token: "x", timeoutMs: 500 });
    const d = await authz.authorize(callerFor("admin"), "project.read", {
      type: "Project",
      id: "p",
    });
    expect(d).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });
});
