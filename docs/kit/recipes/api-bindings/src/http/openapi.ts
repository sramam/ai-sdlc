// The OpenAPI 3.1 document, rendered from the manifest: the same routes the
// router serves, with schemas from each capability's own Zod schemas.
// Committed as `openapi.json`; `openapi.test.ts` fails when it is stale.
import { z } from "zod";
import type { Capability } from "../../../api/src/capability";
import type { Exclusions } from "../../../api/src/manifest";
import { httpPath, reachable } from "../surface";

export type OpenApiInfo = { title: string; version: string; basePath: string };

const schemaOf = (s: z.ZodType, io: "input" | "output") => {
  const rest = { ...(z.toJSONSchema(s, { io }) as Record<string, unknown>) };
  delete rest.$schema; // the document or tool list states its own dialect
  return rest;
};

const refusalRef = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Refusal" } } },
});

export function renderOpenApi(
  manifest: readonly Capability[],
  exclusions: Exclusions,
  info: OpenApiInfo,
) {
  const paths: Record<string, unknown> = {};
  for (const cap of manifest) {
    if (!reachable(cap.name, "http", exclusions)) continue;
    const [entity] = cap.name.split(".");
    paths[info.basePath + httpPath(cap.name)] = {
      post: {
        operationId: cap.name,
        summary: cap.summary,
        tags: [entity],
        "x-effect": cap.effect,
        requestBody: {
          required: true,
          content: { "application/json": { schema: schemaOf(cap.input, "input") } },
        },
        responses: {
          "200": {
            description: "Done.",
            content: { "application/json": { schema: schemaOf(cap.output, "output") } },
          },
          "400": refusalRef("INVALID: the body is not a JSON object."),
          "401": refusalRef("No valid session or API key."),
          "403": refusalRef("FORBIDDEN: the policy, or the credential's scope, says no."),
          "404": refusalRef("NOT_FOUND: no such record in your organization."),
          "409": refusalRef("CONFLICT: the state of the world forbids it."),
          "422": refusalRef("INVALID: a value is wrong; `field` names it."),
          "429": refusalRef("Too many requests."),
          "503": refusalRef("UNAVAILABLE: a dependency could not be asked."),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: info.title, version: info.version },
    security: [{ session: [] }, { apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "__Secure-better-auth.session_token" },
        apiKey: { type: "http", scheme: "bearer", description: "An API key from the app." },
      },
      schemas: {
        Refusal: {
          type: "object",
          required: ["ok", "code", "detail"],
          properties: {
            ok: { const: false },
            code: { enum: ["INVALID", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNAVAILABLE"] },
            detail: { type: "string" },
            field: { type: "string" },
          },
        },
      },
    },
  };
}
