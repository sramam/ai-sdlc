// The manifest: every capability, once. OpenAPI, the HTTP router, the MCP tool
// list and the agent's tool table are this list rendered four ways; a Server
// Function binding is written by hand and names its capability.
import type { Capability } from "./capability";
import { projectCreate, projectList, projectRename } from "./example/project";

export const manifest: readonly Capability[] = [projectCreate, projectList, projectRename];

/** Keys no input may carry: authority comes from the resolved Caller, never the body. */
export const AUTHORITY_KEYS = ["tenantId", "organizationId", "orgId", "userId", "role", "party"];
