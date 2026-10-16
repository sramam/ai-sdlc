// What every binding agrees on, derived from a capability's name and nothing
// else: its HTTP path, its MCP tool name, and which bindings offer it. Pure and
// dependency-free, so the SDK can import it into a browser bundle.
import type { Binding, Exclusions } from "../../api/src/manifest";
import type { Refusal } from "../../api/src/refusal";

export type { Binding, Exclusions };
export const BINDINGS: readonly Binding[] = ["http", "mcp", "sdk"];

/** `project.create` → `/project/create`, under the router's base path. */
export function httpPath(name: string): string {
  const [entity, verb] = name.split(".");
  return `/${entity}/${verb}`;
}

/**
 * `project.create` → `project_create`. MCP allows dots in a tool name, but
 * model APIs that clients forward tools to do not (Anthropic's tool names are
 * `[a-zA-Z0-9_-]`), so a dot would make the tool unusable in some clients.
 */
export function toolName(name: string): string {
  return name.replace(".", "_");
}

/** Reachable unless the manifest's exclusions name this binding for it. */
export function reachable(name: string, binding: Binding, exclusions: Exclusions): boolean {
  return !exclusions[name]?.[binding];
}

/** HTTP status for a refusal. `INVALID` with a field is 422 (the body parsed; a value is wrong). */
export function statusFor(r: Refusal): number {
  switch (r.code) {
    case "INVALID":
      return r.field ? 422 : 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "UNAVAILABLE":
      return 503;
  }
}
