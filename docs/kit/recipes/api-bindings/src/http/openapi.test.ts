// `openapi.json` is generated and committed; this fails when it is stale.
// `pnpm openapi:write` rewrites it. Compared as parsed JSON, so a formatter
// reflowing the file is not staleness.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exclusions, manifest } from "../../../api/src/manifest";
import { BASE } from "../test-support";
import { renderOpenApi } from "./openapi";

const file = join(import.meta.dirname, "../../openapi.json");
const doc = renderOpenApi(manifest, exclusions, {
  title: "App API",
  version: "0.1.0",
  basePath: BASE,
});

describe("openapi.json", () => {
  it("is current (pnpm openapi:write regenerates it)", () => {
    if (process.env.OPENAPI_WRITE) writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    let committed: unknown;
    try {
      committed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error("OPENAPI-001: openapi.json is missing or not JSON; run pnpm openapi:write");
    }
    expect(committed, "OPENAPI-002: openapi.json is stale; run pnpm openapi:write").toEqual(doc);
  });

  it("describes each route with the capability's own schemas", () => {
    expect(doc.paths[`${BASE}/project/create`]).toMatchObject({
      post: { operationId: "project.create", "x-effect": "write" },
    });
    const op = (doc.paths[`${BASE}/project/create`] as { post: { requestBody: unknown } }).post;
    expect(op.requestBody).toHaveProperty(["content", "application/json", "schema"]);
    const body = op.requestBody as { content: Record<string, { schema: unknown }> };
    expect(body.content["application/json"]!.schema).toMatchObject({
      type: "object",
      required: ["name"],
      additionalProperties: false,
    });
  });
});
