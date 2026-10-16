// One scenario, four ways in: `invoke`, the HTTP router, the SDK (fetch bound
// to the router) and MCP (in-process transport). Each run starts from an empty
// Postgres (PGlite), and the four transcripts must be identical: the same
// outputs, the same refusals with the same codes, details and fields.
import { describe, expect, it } from "vitest";
import { invoke, type Capability } from "../../api/src/capability";
import { exclusions, manifest, type CapabilityName } from "../../api/src/manifest";
import { scriptedAuthz } from "../../api/src/scripted-authz";
import { createClient } from "./sdk/client";
import { toolName } from "./surface";
import { APP, BASE, http, mcpClient, newWorld, who, type World } from "./test-support";

type Call = (key: string, name: CapabilityName, input: unknown) => Promise<unknown>;
type Binding = (w: World) => Promise<Call>;

const byName = new Map<string, Capability>(manifest.map((c) => [c.name, c]));

const BINDINGS: Record<string, Binding> = {
  invoke: async (w) => async (key, name, input) =>
    invoke(byName.get(name)!, { db: w.db, authz: w.authz }, (await who(key)).caller, input),

  http: async (w) => {
    const handler = http(w);
    return async (key, name, input) => {
      const [entity, verb] = name.split(".");
      const res = await handler(
        new Request(`${APP}${BASE}/${entity}/${verb}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(input),
        }),
      );
      return res.json();
    };
  },

  sdk: async (w) => {
    const handler = http(w);
    return async (key, name, input) => {
      const api = createClient<typeof manifest, typeof exclusions>({
        baseUrl: `${APP}${BASE}`,
        fetch: (u, init) => handler(new Request(u, init)),
        headers: { authorization: `Bearer ${key}` },
      });
      const [entity, verb] = name.split(".") as [string, string];
      const group = (api as unknown as Record<string, Record<string, (i: unknown) => unknown>>)[
        entity
      ]!;
      return group[verb]!(input);
    };
  },

  mcp: async (w) => async (key, name, input) => {
    const client = await mcpClient(w, key);
    const r = await client.callTool({
      name: toolName(name),
      arguments: input as Record<string, unknown>,
    });
    const text = (r.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(r.structuredContent); // the text and the structure agree
    expect(Boolean(r.isError)).toBe((r.structuredContent as { ok: boolean }).ok === false);
    await client.close();
    return r.structuredContent;
  },
};

/** The scenario: every refusal code, and a success beside each. Returns a transcript. */
async function scenario(w: World, call: Call) {
  const t: unknown[] = [];
  const step = async (key: string, name: CapabilityName, input: unknown) => {
    const r = await call(key, name, input);
    t.push(r);
    return r as { ok: boolean; id?: string };
  };
  const roof = await step("key-alice", "project.create", { name: "Roof" });
  await step("key-alice", "project.create", { name: "R" }); // INVALID on name
  await step("key-alice", "project.create", { name: "Roof", tenantId: "org-b" }); // INVALID, by name
  await step("key-alice", "project.create", { name: "Roof" }); // CONFLICT
  await step("key-bruno", "project.create", { name: "Roof" }); // fine in another tenant
  await step("key-bruno", "project.rename", { id: roof.id, name: "Mine now" }); // NOT_FOUND
  await step("key-alice", "project.rename", { id: roof.id, name: "Roof 2" });
  // The engine's answer changes; the world (and every binding's deps) holds the same object.
  Object.assign(
    w.authz,
    scriptedAuthz({ authorize: { ok: false, code: "FORBIDDEN", detail: "x" } }),
  );
  await step("key-alice", "project.create", { name: "Walls" }); // FORBIDDEN
  Object.assign(
    w.authz,
    scriptedAuthz({ authorize: { ok: false, code: "UNAVAILABLE", detail: "engine down" } }),
  );
  await step("key-alice", "project.create", { name: "Walls" }); // UNAVAILABLE
  Object.assign(w.authz, scriptedAuthz({ listFilter: { ok: true, kind: "sql", where: "true" } }));
  await step("key-alice", "project.list", {});
  await step("key-bruno", "project.list", { search: "roof" });
  // Random ids differ run to run; their positions must not.
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(t).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      (id) => ids.get(id) ?? (ids.set(id, `<id${ids.size}>`), `<id${ids.size - 1}>`),
    ),
  );
}

describe("the same calls give the same answers through every binding", () => {
  let expected: unknown;

  it("invoke (the reference transcript)", async () => {
    const w = await newWorld();
    expected = await scenario(w, await BINDINGS.invoke!(w));
    expect(expected).toEqual([
      { ok: true, id: "<id0>" },
      { ok: false, code: "INVALID", detail: "At least 2 characters.", field: "name" },
      { ok: false, code: "INVALID", detail: expect.any(String), field: "tenantId" },
      { ok: false, code: "CONFLICT", detail: "A project with that name exists.", field: "name" },
      { ok: true, id: "<id1>" },
      { ok: false, code: "NOT_FOUND", detail: "That record does not exist." },
      { ok: true, id: "<id0>", name: "Roof 2" },
      { ok: false, code: "FORBIDDEN", detail: "You may not do that." },
      { ok: false, code: "UNAVAILABLE", detail: "engine down" },
      { ok: true, items: [{ id: "<id0>", name: "Roof 2" }] },
      { ok: true, items: [{ id: "<id1>", name: "Roof" }] },
    ]);
  });

  it.each(["http", "sdk", "mcp"])("%s", async (binding) => {
    const w = await newWorld();
    expect(await scenario(w, await BINDINGS[binding]!(w))).toEqual(expected);
  });
});
