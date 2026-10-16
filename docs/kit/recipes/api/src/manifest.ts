// The manifest: every capability, once. The HTTP router, its OpenAPI document,
// the MCP tool list, the SDK's types and the agent's tool table are this list
// rendered (the api-bindings recipe); a server function binding is written by
// hand and names its capability.
//
// `as const` keeps each entry's literal name and schemas in the type, so the
// SDK is typed from `typeof manifest` with nothing generated.
import type { Capability } from "./capability";
import { projectCreate, projectList, projectRename } from "./example/project";

export const manifest = [
  projectCreate,
  projectList,
  projectRename,
] as const satisfies readonly Capability[];

export type CapabilityName = (typeof manifest)[number]["name"];

/** The bindings every capability is reachable through, unless excluded below. */
export type Binding = "http" | "mcp" | "sdk";

/**
 * Capabilities a binding does not offer, each with a reason that is a property
 * of the mechanism ("the upload step needs the browser's file picker"), never
 * of the effort. Keyed by name rather than set on the entry, so an exclusion
 * that outlives its capability is visible: the api-bindings pattern check fails
 * on it, on a reason under four words, and on a capability missing from a
 * binding with no line here. The SDK calls HTTP, so an `http` exclusion names
 * `sdk` too.
 */
export type Exclusions = Readonly<Record<string, Readonly<Partial<Record<Binding, string>>>>>;

export const exclusions = {} as const satisfies Exclusions;

/** Keys no input may carry: authority comes from the resolved Caller, never the body. */
export const AUTHORITY_KEYS = ["tenantId", "organizationId", "orgId", "userId", "role", "party"];
