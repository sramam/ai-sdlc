// The bindings pattern check, against what each binding actually renders, and
// then tripped both ways with surfaces and exclusions a test makes up.
import { describe, expect, it } from "vitest";
import { exclusions, manifest } from "../../api/src/manifest";
import { checkBindings, type Surfaces } from "./bindings.pattern-check";
import { renderOpenApi } from "./http/openapi";
import { createClient } from "./sdk/client";
import { httpPath, toolName } from "./surface";
import { APP, BASE, http, mcpClient, newWorld } from "./test-support";

const names = manifest.map((c) => c.name as string);

/** Ask each rendering what it offers. Nothing here reads the exclusions table. */
async function renderedSurfaces(): Promise<Surfaces> {
  const handler = http(await newWorld());
  // The router: an unauthenticated call is 401 if the route exists, 404 if not.
  const httpSet = new Set<string>();
  for (const n of names) {
    const res = await handler(
      new Request(`${APP}${BASE}${httpPath(n)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    if (res.status !== 404) httpSet.add(n);
  }
  // The document: its operations.
  const doc = renderOpenApi(manifest, exclusions, { title: "t", version: "0", basePath: BASE });
  const openapi = new Set(
    Object.values(doc.paths).map((p) => (p as { post: { operationId: string } }).post.operationId),
  );
  // MCP: tools/list, mapped back to capability names.
  const client = await mcpClient(await newWorld(), "key-alice");
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  const mcp = new Set(names.filter((n) => tools.has(toolName(n))));
  // The SDK: its own request, through the router.
  const sdkSet = new Set<string>();
  for (const n of names) {
    const [e, v] = n.split(".") as [string, string];
    const api = createClient<readonly []>({
      baseUrl: `${APP}${BASE}`,
      fetch: (u, i) => handler(new Request(u, i)),
    });
    const group = (
      api as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>
    )[e]!;
    const r = (await group[v]!({})) as { detail?: string };
    if (r.detail !== "No such capability.") sdkSet.add(n);
  }
  return { http: httpSet, openapi, mcp, sdk: sdkSet };
}

describe("bindings pattern check", () => {
  it("every capability is reachable through HTTP, OpenAPI, MCP and the SDK, or excluded with a reason", async () => {
    const { rows, problems } = checkBindings(names, exclusions, await renderedSurfaces());
    // Printed on success too (principles.md §5).
    process.stdout.write(
      rows
        .map(
          (r) =>
            `${r.capability.padEnd(16)} http:${r.http} openapi:${r.openapi} mcp:${r.mcp} sdk:${r.sdk}`,
        )
        .join("\n") + "\n",
    );
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(names.length);
  });

  describe("tripped", () => {
    const all = (): Surfaces => ({
      http: new Set(names),
      openapi: new Set(names),
      mcp: new Set(names),
      sdk: new Set(names),
    });

    it("a capability missing from a binding, with no exclusion", () => {
      const s = all();
      (s.mcp as Set<string>).delete("project.rename");
      expect(checkBindings(names, {}, s).problems).toEqual([
        "project.rename: missing from mcp, and no exclusion says why",
      ]);
    });

    it("an exclusion whose capability no longer exists", () => {
      const problems = checkBindings(
        names,
        { "project.archive": { mcp: "the archive needs a person's confirmation" } },
        all(),
      ).problems;
      expect(problems).toEqual([
        "project.archive: excluded, but no such capability (delete the line)",
      ]);
    });

    it("an exclusion with a reason under four words", () => {
      const s = all();
      (s.mcp as Set<string>).delete("project.rename");
      expect(checkBindings(names, { "project.rename": { mcp: "not needed" } }, s).problems).toEqual(
        ["project.rename: the mcp exclusion needs a reason (4+ words)"],
      );
    });

    it("an exclusion that no longer applies: the binding offers it anyway", () => {
      expect(
        checkBindings(
          names,
          { "project.rename": { mcp: "renames need the browser's undo toast" } },
          all(),
        ).problems,
      ).toEqual(["project.rename: excluded from mcp, but mcp offers it"]);
    });

    it("an http exclusion that leaves the SDK pointing at nothing", () => {
      const s = all();
      for (const b of ["http", "openapi"] as const) (s[b] as Set<string>).delete("project.rename");
      expect(
        checkBindings(
          names,
          { "project.rename": { http: "the upload step needs the browser's file picker" } },
          s,
        ).problems,
      ).toEqual(["project.rename: excluded from http, so from sdk too (the SDK calls HTTP)"]);
    });

    it("a well-formed exclusion passes, and the row says why", () => {
      const s = all();
      (s.mcp as Set<string>).delete("project.rename");
      const { rows, problems } = checkBindings(
        names,
        { "project.rename": { mcp: "renames need the browser's undo toast" } },
        s,
      );
      expect(problems).toEqual([]);
      expect(rows.find((r) => r.capability === "project.rename")?.mcp).toBe(
        "excluded: renames need the browser's undo toast",
      );
    });

    it("a binding offering something the manifest does not have", () => {
      const s = all();
      (s.sdk as Set<string>).add("project.delete");
      expect(checkBindings(names, {}, s).problems).toEqual([
        "project.delete: sdk offers it, but the manifest has no such capability",
      ]);
    });
  });
});
