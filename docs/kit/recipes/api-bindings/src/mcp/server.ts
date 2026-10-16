// The MCP binding, rendered from the manifest: one tool per capability.
//
// - name: `toolName(cap.name)`; description: `summary`
// - inputSchema / outputSchema: the capability's Zod schemas, as JSON Schema
// - annotations.readOnlyHint: `effect === "read"`
// - a refusal is a tool error (`isError: true`) whose text and
//   `structuredContent` are the refusal itself: code, detail, field
//
// The low-level `Server` rather than `McpServer.registerTool`, deliberately:
// registerTool validates arguments itself and answers a bad one with its own
// error, so INVALID-with-field would differ between MCP and every other
// binding. Here the port validates, once, for all of them.
//
// One server per request (`createMcpHandler`'s factory), so each carries
// exactly one caller's authority and nothing outlives the request: the shape
// Workers wants.
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { z } from "zod";
import { invoke, type Capability, type Deps } from "../../../api/src/capability";
import type { Exclusions } from "../../../api/src/manifest";
import { refuse, type Refusal } from "../../../api/src/refusal";
import { withinScope, type Authenticated } from "../auth/principal";
import { reachable, toolName } from "../surface";

export type McpOptions = {
  manifest: readonly Capability[];
  exclusions: Exclusions;
  info: { name: string; version: string };
  deps(): Deps | Promise<Deps>;
  limit?(key: string): Promise<boolean>;
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const asResult = (value: Record<string, unknown>, isError: boolean): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  isError,
});

const schemaOf = (s: z.ZodType, io: "input" | "output") => {
  const rest = { ...(z.toJSONSchema(s, { io }) as Record<string, unknown>) };
  delete rest.$schema; // the document or tool list states its own dialect
  return rest as { type: "object"; [k: string]: unknown };
};

/** The tools this manifest offers over MCP. */
export function mcpTools(o: Pick<McpOptions, "manifest" | "exclusions">) {
  return o.manifest
    .filter((c) => reachable(c.name, "mcp", o.exclusions))
    .map((c) => ({
      cap: c,
      tool: {
        name: toolName(c.name),
        description: c.summary,
        inputSchema: schemaOf(c.input, "input"),
        outputSchema: schemaOf(c.output, "output"),
        annotations: { readOnlyHint: c.effect === "read" },
      },
    }));
}

/** An MCP server acting for exactly one authenticated caller. */
export function mcpServer(o: McpOptions, who: Authenticated): Server {
  const tools = mcpTools(o);
  const byName = new Map(tools.map((t) => [t.tool.name, t.cap]));
  const server = new Server(o.info, { capabilities: { tools: {} } });

  server.setRequestHandler("tools/list", async () => ({ tools: tools.map((t) => t.tool) }));
  server.setRequestHandler("tools/call", async (request) => {
    const cap = byName.get(request.params.name);
    const refused = (r: Refusal) => asResult(r, true);
    if (!cap) return refused(refuse("NOT_FOUND", "No such tool."));
    if (!withinScope(who.scopes, cap.effect))
      return refused(refuse("FORBIDDEN", "This token's scope does not allow that."));
    if (o.limit && !(await o.limit(who.rateKey)))
      return refused(refuse("UNAVAILABLE", "Too many requests. Try again shortly."));
    const result = (await invoke(
      cap,
      await o.deps(),
      who.caller,
      request.params.arguments ?? {},
    )) as Record<string, unknown> | Refusal;
    return result.ok ? asResult(result, false) : refused(result as Refusal);
  });
  return server;
}

/**
 * The Streamable HTTP endpoint: a fetch-shaped handler for a TanStack Start
 * server route (`/mcp`). Put it behind `mcpAuth` (../auth/better-auth.ts),
 * which supplies `who`. Serves both protocol eras: 2026-07-28 requests, and
 * 2025-era clients through the SDK's stateless fallback.
 */
export function createMcpEndpoint(o: McpOptions) {
  const handler = createMcpHandler(
    (ctx) => mcpServer(o, ctx.authInfo?.extra?.who as Authenticated),
    { legacy: "stateless" },
  );
  return (request: Request, who: Authenticated) =>
    handler.fetch(request, {
      authInfo: { token: "verified", clientId: who.rateKey, scopes: [], extra: { who } },
    });
}
