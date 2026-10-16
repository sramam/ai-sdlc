// The policy matrix, against a real Oso Dev Server and a real Postgres (PGlite).
// Needs the Dev Server (README § Run the tests); without it every case is
// reported as skipped with the reason, never as passed.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { CATALOGUE, osoAuthz } from "./oso";
import { WORLD, callerFor, checkCases, listCases, parseAccessModel } from "./matrix";

const OSO_URL = process.env.OSO_URL ?? "http://127.0.0.1:8080";
const DEV_TOKEN = "e_0123456789_12345_osotesttoken01xiIn"; // the Dev Server's fixed test token
const here = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const rows = parseAccessModel(here("access-model.example.md"));

const reachable = await fetch(`${OSO_URL}/api/healthcheck`, { signal: AbortSignal.timeout(1000) })
  .then((r) => r.ok)
  .catch(() => false);

/** An isolated environment on the Dev Server, with this repo's policy loaded (its Polar tests run on load). */
async function testEnvironment(): Promise<string> {
  const env = await fetch(`${OSO_URL}/test_environment?copy=false`, {
    method: "POST",
    headers: { authorization: `Bearer ${DEV_TOKEN}` },
  }).then((r) => r.json() as Promise<{ token: string }>);
  const r = await fetch(`${OSO_URL}/api/policy`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
    body: JSON.stringify({ filename: "policy.polar", src: here("policy.polar") }),
  });
  if (!r.ok) throw new Error(`policy refused (${r.status}): ${await r.text()}`);
  return env.token;
}

async function worldDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create table membership (user_id text not null, org_id text not null, role text not null);
    create table project (id text primary key, org_id text not null, created_by text not null);
  `);
  for (const m of WORLD.memberships) {
    await db.query("insert into membership values ($1, $2, $3)", [m.userId, m.orgId, m.role]);
  }
  for (const p of WORLD.projects) {
    await db.query("insert into project values ($1, $2, $3)", [p.id, p.orgId, p.createdBy]);
  }
  return db;
}

if (!reachable) {
  describe("oso matrix", () => {
    it.skip(`COULD NOT RUN: no Oso Dev Server at ${OSO_URL} (README § Run the tests)`, () => {});
  });
} else {
  describe.each(["local", "centralized"] as const)("oso matrix (%s facts)", (mode) => {
    let authz: ReturnType<typeof osoAuthz>;
    let db: PGlite;

    beforeAll(async () => {
      const token = await testEnvironment();
      db = await worldDb();
      if (mode === "local") {
        authz = osoAuthz({
          url: OSO_URL,
          apiKey: token,
          local: {
            dataBindings: here("data-bindings.yaml"),
            idColumn: { Project: "project.id" },
            queryOne: async (sql) => (await db.query<Record<string, unknown>>(sql)).rows[0],
          },
        });
      } else {
        // Centralized: the same world written to Oso as facts (in a project, through an outbox).
        const v = (type: string, id: string) => ({ type, id });
        const facts = [
          ...WORLD.memberships.map((m) => ({
            predicate: "has_role",
            args: [v("User", m.userId), v("String", m.role), v("Organization", m.orgId)],
          })),
          ...WORLD.projects.flatMap((p) => [
            {
              predicate: "has_relation",
              args: [v("Project", p.id), v("String", "parent"), v("Organization", p.orgId)],
            },
            {
              predicate: "has_relation",
              args: [v("Project", p.id), v("String", "creator"), v("User", p.createdBy)],
            },
          ]),
        ];
        const r = await fetch(`${OSO_URL}/api/batch`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify([{ inserts: facts }]),
        });
        expect(r.ok, await r.clone().text()).toBe(true);
        authz = osoAuthz({ url: OSO_URL, apiKey: token });
      }
    });

    it.each(checkCases(rows))("$name", async (c) => {
      const d = await authz.authorize(callerFor(c.persona), c.action, c.resource);
      expect(d.ok, JSON.stringify(d)).toBe(c.allowed);
      if (!d.ok) expect(d.code).toBe("FORBIDDEN");
    });

    it.each(listCases(rows))("$name", async (c) => {
      const f = await authz.listFilter(callerFor(c.persona), c.action, "Project");
      if (!f.ok) throw new Error(JSON.stringify(f));
      const ids =
        f.kind === "ids"
          ? [...f.ids]
          : (await db.query<{ id: string }>(`select id from project where ${f.where}`)).rows.map(
              (r) => r.id,
            );
      const inA = ids.filter((id) => id !== "p-b").sort();
      expect(inA).toEqual(c.visibleInA);
    });
  });

  describe("oso: default deny and could-not-ask", () => {
    it("every action in the catalogue appears in the access model, and vice versa", () => {
      const declared = Object.entries(CATALOGUE).flatMap(([t, as]) => as.map((a) => `${t}:${a}`));
      const modelled = rows.map((r) => `${r.resource}:${r.capability}`);
      expect(declared.sort()).toEqual(modelled.sort());
    });

    it("refuses an unknown action or type before asking the engine", async () => {
      let asked = 0;
      const authz = osoAuthz({
        url: OSO_URL,
        apiKey: DEV_TOKEN,
        fetch: async (...a) => (asked++, fetch(...a)),
      });
      const admin = callerFor("admin");
      expect(
        await authz.authorize(admin, "project.nuke", { type: "Project", id: "p-own" }),
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
      const authz = osoAuthz({ url: "http://127.0.0.1:9", apiKey: DEV_TOKEN, timeoutMs: 500 });
      const d = await authz.authorize(callerFor("admin"), "project.read", {
        type: "Project",
        id: "p-own",
      });
      expect(d).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    });

    it("a policy whose Polar tests fail is refused on load", async () => {
      const env = await fetch(`${OSO_URL}/test_environment?copy=false`, {
        method: "POST",
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      }).then((r) => r.json() as Promise<{ token: string }>);
      const broken = here("policy.polar").replace(
        'assert_not allow(User{"m"}, "project.delete"',
        'assert allow(User{"m"}, "project.delete"',
      );
      const r = await fetch(`${OSO_URL}/api/policy`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
        body: JSON.stringify({ filename: "policy.polar", src: broken }),
      });
      expect(r.status).toBe(400);
      expect(await r.text()).toContain("TestsFailed");
    });

    it("an id containing a quote cannot escape Oso's generated SQL", async () => {
      const token = await testEnvironment();
      const db = await worldDb();
      const authz = osoAuthz({
        url: OSO_URL,
        apiKey: token,
        local: {
          dataBindings: here("data-bindings.yaml"),
          idColumn: { Project: "project.id" },
          queryOne: async (sql) => (await db.query<Record<string, unknown>>(sql)).rows[0],
        },
      });
      const evil = { userId: "x' or '1'='1", tenantId: "org-a" };
      const f = await authz.listFilter(evil, "project.read", "Project");
      if (!f.ok || f.kind !== "sql") throw new Error(JSON.stringify(f));
      const seen = await db.query(`select id from project where ${f.where}`);
      expect(seen.rows).toEqual([]);
    });
  });
}
