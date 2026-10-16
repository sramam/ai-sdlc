// `@scope/authz` over SpiceDB's HTTP API, with plain `fetch` so it runs on
// Workers. The official Node client (@authzed/authzed-node) speaks gRPC over
// HTTP/2, which a Worker cannot open; the HTTP gateway (`--http-enabled`)
// serves the same v1 API as JSON.
import {
  checkVocabulary,
  forbidden,
  unavailable,
  type ActionCatalogue,
  type Authz,
  type AuthzCaller,
  type AuthzRefusal,
  type Decision,
  type ListFilter,
  type ResourceRef,
} from "./authz";

/** Each action → the schema's object type and permission (SpiceDB names allow no dots). */
export const PERMISSIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Organization: { "project.create": "project_create" },
  Project: {
    "project.read": "project_read",
    "project.update": "project_update",
    "project.delete": "project_delete",
  },
};
export const OBJECT_TYPE: Readonly<Record<string, string>> = {
  Organization: "organization",
  Project: "project",
};
export const CATALOGUE: ActionCatalogue = Object.fromEntries(
  Object.entries(PERMISSIONS).map(([t, m]) => [t, Object.keys(m)]),
);

export type Consistency =
  { fullyConsistent: true } | { minimizeLatency: true } | { atLeastAsFresh: { token: string } };

export type SpiceDbConfig = {
  /** The HTTP gateway, e.g. `http://127.0.0.1:8443`. */
  url: string;
  /** The preshared key. Under `serve-testing`, each token is its own isolated datastore. */
  token: string;
  /**
   * Default `fullyConsistent`: correct first. Production usually wants
   * `atLeastAsFresh` with the ZedToken stored by the outbox relay.
   */
  consistency?: () => Consistency;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export function spicedbClient(config: SpiceDbConfig) {
  const doFetch = config.fetch ?? fetch;
  return async function call(path: string, body: unknown): Promise<Response | AuthzRefusal> {
    try {
      const res = await doFetch(`${config.url.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs ?? 2000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return unavailable(
          `AUTHZ-SPICEDB-002: ${path} answered ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      return res;
    } catch (error) {
      return unavailable(
        `AUTHZ-SPICEDB-001: SpiceDB unreachable at ${config.url}: ${String(error)}`,
      );
    }
  };
}

const user = (caller: AuthzCaller) => ({ object: { objectType: "user", objectId: caller.userId } });

export function spicedbAuthz(config: SpiceDbConfig): Authz {
  const call = spicedbClient(config);
  const consistency = () => config.consistency?.() ?? { fullyConsistent: true };
  const isRefusal = (v: Response | AuthzRefusal): v is AuthzRefusal => !(v instanceof Response);

  return {
    async authorize(caller, action, resource: ResourceRef): Promise<Decision> {
      const bad = checkVocabulary(CATALOGUE, action, resource.type);
      if (bad) return bad;
      const res = await call("/v1/permissions/check", {
        consistency: consistency(),
        resource: { objectType: OBJECT_TYPE[resource.type], objectId: resource.id },
        permission: PERMISSIONS[resource.type]![action],
        subject: user(caller),
      });
      if (isRefusal(res)) return res;
      const body = (await res.json()) as { permissionship?: string };
      if (body.permissionship === "PERMISSIONSHIP_HAS_PERMISSION") return { ok: true };
      if (body.permissionship === "PERMISSIONSHIP_NO_PERMISSION") {
        return forbidden(`${action} on ${resource.type}`);
      }
      // CONDITIONAL_PERMISSION (caveats) or anything new: could not decide, so refuse.
      return unavailable(`AUTHZ-SPICEDB-003: undecided permissionship ${body.permissionship}`);
    },

    async listFilter(caller, action, resourceType): Promise<ListFilter | AuthzRefusal> {
      const bad = checkVocabulary(CATALOGUE, action, resourceType);
      if (bad) return bad;
      const res = await call("/v1/permissions/resources", {
        consistency: consistency(),
        resourceObjectType: OBJECT_TYPE[resourceType],
        permission: PERMISSIONS[resourceType]![action],
        subject: user(caller),
      });
      if (isRefusal(res)) return res;
      // A server stream, delivered as newline-delimited JSON: {"result": {...}} or {"error": {...}}.
      const ids: string[] = [];
      for (const line of (await res.text()).split("\n")) {
        if (!line.trim()) continue;
        const item = JSON.parse(line) as {
          result?: { resourceObjectId: string; permissionship: string };
          error?: { message?: string };
        };
        if (item.error)
          return unavailable(`AUTHZ-SPICEDB-004: ${item.error.message ?? "stream error"}`);
        // Only definite answers; a conditional (caveated) result is not a yes.
        if (item.result?.permissionship === "LOOKUP_PERMISSIONSHIP_HAS_PERMISSION") {
          ids.push(item.result.resourceObjectId);
        }
      }
      return { ok: true, kind: "ids", ids };
    },
  };
}
