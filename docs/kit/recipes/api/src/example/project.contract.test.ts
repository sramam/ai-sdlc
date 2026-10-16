// The contract suite: the port against a real Postgres (PGlite, in process).
// Every refusal is paired with the same call succeeding where it should, and a
// write is read back, so "refused but written" cannot pass.
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { invoke, type Deps } from "../capability";
import { resolveCaller, type Caller } from "../caller";
import { scriptedAuthz } from "../scripted-authz";
import { projectCreate, projectList, projectRename } from "./project";
import { project } from "./schema";

const caller = (userId: string, tenantId: string, role = "admin"): Caller => {
  const c = resolveCaller({ userId }, { tenantId, role, party: null });
  if ("ok" in c) throw new Error(c.detail);
  return c;
};
const alice = caller("u-alice", "org-a");
const bruno = caller("u-bruno", "org-b");

let db: ReturnType<typeof drizzle>;
beforeEach(async () => {
  const pg = new PGlite();
  // In a project: the drizzle-kit migrations, applied by createTestDb (db recipe).
  await pg.exec(`
    create table project (
      id text primary key, tenant_id text not null, name text not null,
      created_by text not null, created_at timestamptz not null default now());
    create unique index project_tenant_name on project (tenant_id, name);`);
  db = drizzle(pg);
});
const deps = (authz = scriptedAuthz({})): Deps & { authz: ReturnType<typeof scriptedAuthz> } => ({
  db,
  authz,
});

describe("project.create", () => {
  it("creates in the caller's tenant, and returns an id, not a row", async () => {
    const r = await invoke(projectCreate, deps(), alice, { name: "Roof" });
    expect(projectCreate.output.parse(r)).toEqual({ ok: true, id: expect.any(String) });
    const [row] = await db.select().from(project);
    expect(row).toMatchObject({ tenantId: "org-a", name: "Roof", createdBy: "u-alice" });
  });

  it("refuses a tenant in the body, by name, and writes nothing", async () => {
    const r = await invoke(projectCreate, deps(), alice, { name: "Roof", tenantId: "org-b" });
    expect(r).toMatchObject({ ok: false, code: "INVALID", field: "tenantId" });
    expect(await db.select().from(project)).toEqual([]);
  });

  it("puts a validation refusal on its field", async () => {
    expect(await invoke(projectCreate, deps(), alice, { name: "R" })).toMatchObject({
      ok: false,
      code: "INVALID",
      field: "name",
    });
  });

  it("a duplicate name is CONFLICT on `name` in the same tenant, and fine in another", async () => {
    await invoke(projectCreate, deps(), alice, { name: "Roof" });
    expect(await invoke(projectCreate, deps(), alice, { name: "Roof" })).toMatchObject({
      code: "CONFLICT",
      field: "name",
    });
    expect(await invoke(projectCreate, deps(), bruno, { name: "Roof" })).toMatchObject({
      ok: true,
    });
  });

  it("FORBIDDEN and UNAVAILABLE from the engine both refuse, and nothing is written", async () => {
    for (const code of ["FORBIDDEN", "UNAVAILABLE"] as const) {
      const authz = scriptedAuthz({ authorize: { ok: false, code, detail: "scripted" } });
      expect(await invoke(projectCreate, deps(authz), alice, { name: "Roof" })).toMatchObject({
        code,
      });
    }
    expect(await db.select().from(project)).toEqual([]);
  });
});

describe("project.rename", () => {
  it("renames in the caller's tenant", async () => {
    const { id } = (await invoke(projectCreate, deps(), alice, { name: "Roof" })) as { id: string };
    expect(await invoke(projectRename, deps(), alice, { id, name: "Roof 2" })).toEqual({
      ok: true,
      id,
      name: "Roof 2",
    });
  });

  it("another tenant's id is NOT_FOUND, the engine is never asked, and the row is unchanged", async () => {
    const { id } = (await invoke(projectCreate, deps(), alice, { name: "Roof" })) as { id: string };
    const d = deps(); // the engine would say yes: the scope check alone must hold
    expect(await invoke(projectRename, d, bruno, { id, name: "Mine now" })).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(d.authz.asked).toEqual([]);
    expect((await db.select().from(project).where(eq(project.id, id)))[0]?.name).toBe("Roof");
  });
});

describe("project.list", () => {
  beforeEach(async () => {
    for (const name of ["Alpha", "Beta", "Gamma"])
      await invoke(projectCreate, deps(), alice, { name });
    await invoke(projectCreate, deps(), bruno, { name: "Bruno's" });
  });
  const idsByName = async () =>
    Object.fromEntries((await db.select().from(project)).map((r) => [r.name, r.id]));

  it("an ids filter is applied in the query, and never reaches another tenant", async () => {
    const ids = await idsByName();
    // The engine lists Bruno's project too (a person can hold roles in both); scope removes it.
    const authz = scriptedAuthz({
      listFilter: { ok: true, kind: "ids", ids: [ids.Alpha!, ids.Gamma!, ids["Bruno's"]!] },
    });
    const r = await invoke(projectList, deps(authz), alice, {});
    expect(projectList.output.parse(r).items.map((i) => i.name)).toEqual(["Alpha", "Gamma"]);
  });

  it("a SQL filter (Oso local authorization) is applied in the query", async () => {
    const authz = scriptedAuthz({
      listFilter: { ok: true, kind: "sql", where: "project.name in ('Beta')" },
    });
    const r = await invoke(projectList, deps(authz), alice, {});
    expect(projectList.output.parse(r).items.map((i) => i.name)).toEqual(["Beta"]);
  });

  it("an empty filter returns nothing, and an unreachable engine refuses", async () => {
    const none = scriptedAuthz({ listFilter: { ok: true, kind: "ids", ids: [] } });
    expect(await invoke(projectList, deps(none), alice, {})).toEqual({ ok: true, items: [] });
    const down = scriptedAuthz({ listFilter: { ok: false, code: "UNAVAILABLE", detail: "down" } });
    expect(await invoke(projectList, deps(down), alice, {})).toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("the Caller", () => {
  it("cannot be resolved without an active relationship", () => {
    expect(resolveCaller({ userId: "u" }, null)).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("a party-scoped role with no party is a loud defect, not a whole-tenant view", () => {
    expect(() =>
      resolveCaller({ userId: "u" }, { tenantId: "t", role: "customer", party: null }),
    ).toThrow(/CALLER-001/);
  });
});
