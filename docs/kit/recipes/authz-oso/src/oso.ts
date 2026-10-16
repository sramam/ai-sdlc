// `@scope/authz` over Oso Cloud's HTTP API, with plain `fetch` so it runs on
// Workers. The `oso-cloud` npm SDK (2.6.0) is CommonJS and requires `fs`,
// `http`, `https` and `dns/promises`, and reads data bindings from a file path,
// so it is not used here (README § Why not the SDK).
//
// Two modes, one policy:
// - local (default): facts are read from OUR Postgres through data-bindings.yaml.
//   Oso returns SQL; we run it. Nothing is written to Oso, so there are no
//   dual writes and no outbox.
// - centralized: facts live in Oso (written through an outbox, see authz-spicedb's
//   outbox.ts for the shape); `authorize` and `list` answer directly.
import {
  checkVocabulary,
  unavailable,
  forbidden,
  type ActionCatalogue,
  type Authz,
  type AuthzCaller,
  type AuthzRefusal,
  type Decision,
  type ListFilter,
  type ResourceRef,
} from "./authz";

/** Every action per resource type in policy.polar. The matrix test checks this against the policy. */
export const CATALOGUE: ActionCatalogue = {
  Organization: ["project.create"],
  Project: ["project.read", "project.update", "project.delete"],
};

export type OsoConfig = {
  /** Oso Cloud, or the Dev Server (`http://localhost:8080`) locally and in tests. */
  url: string;
  apiKey: string;
  catalogue?: ActionCatalogue;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Local authorization. Omit for centralized facts. */
  local?: {
    /** The contents of data-bindings.yaml (a string: Workers have no disk to read it from). */
    dataBindings: string;
    /** The id column each resource type's rows are filtered on, e.g. `project.id`. */
    idColumn: Readonly<Record<string, string>>;
    /** Runs Oso's generated query against our database; returns its first row. */
    queryOne(sql: string): Promise<Record<string, unknown> | undefined>;
  };
};

const ACTOR_TYPE = "User";

export function osoAuthz(config: OsoConfig): Authz {
  const catalogue = config.catalogue ?? CATALOGUE;
  const doFetch = config.fetch ?? fetch;

  async function post(path: string, body: unknown): Promise<unknown | AuthzRefusal> {
    let res: Response;
    try {
      res = await doFetch(`${config.url.replace(/\/$/, "")}/api${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs ?? 2000),
      });
    } catch (error) {
      return unavailable(`AUTHZ-OSO-001: Oso unreachable at ${config.url}: ${String(error)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return unavailable(
        `AUTHZ-OSO-002: Oso answered ${res.status} to ${path}: ${text.slice(0, 300)}`,
      );
    }
    return res.json();
  }

  const isRefusal = (v: unknown): v is AuthzRefusal =>
    typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

  return {
    async authorize(caller: AuthzCaller, action: string, resource: ResourceRef): Promise<Decision> {
      const bad = checkVocabulary(catalogue, action, resource.type);
      if (bad) return bad;
      const query = {
        actor_type: ACTOR_TYPE,
        actor_id: caller.userId,
        action,
        resource_type: resource.type,
        resource_id: resource.id,
        context_facts: [],
      };
      if (!config.local) {
        const r = await post("/authorize", query);
        if (isRefusal(r)) return r;
        return (r as { allowed?: unknown }).allowed === true
          ? { ok: true }
          : forbidden(`${action} on ${resource.type}`);
      }
      const r = await post("/authorize_query", { query, data_bindings: config.local.dataBindings });
      if (isRefusal(r)) return r;
      const sql = (r as { sql?: unknown }).sql;
      if (typeof sql !== "string")
        return unavailable("AUTHZ-OSO-003: authorize_query returned no sql");
      let row: Record<string, unknown> | undefined;
      try {
        row = await config.local.queryOne(sql);
      } catch (error) {
        return unavailable(`AUTHZ-OSO-004: running Oso's query failed: ${String(error)}`);
      }
      return row?.allowed === true ? { ok: true } : forbidden(`${action} on ${resource.type}`);
    },

    async listFilter(caller, action, resourceType): Promise<ListFilter | AuthzRefusal> {
      const bad = checkVocabulary(catalogue, action, resourceType);
      if (bad) return bad;
      if (!config.local) {
        const r = await post("/list", {
          actor_type: ACTOR_TYPE,
          actor_id: caller.userId,
          action,
          resource_type: resourceType,
          context_facts: [],
        });
        if (isRefusal(r)) return r;
        const ids = (r as { results?: unknown }).results;
        if (!Array.isArray(ids)) return unavailable("AUTHZ-OSO-005: list returned no results");
        return { ok: true, kind: "ids", ids: ids.map(String) };
      }
      const column = config.local.idColumn[resourceType];
      if (!column) return forbidden(`no id column declared for ${resourceType}`);
      const r = await post("/list_query", {
        query: {
          actor_type: ACTOR_TYPE,
          actor_id: caller.userId,
          action,
          resource_type: resourceType,
          context_facts: [],
        },
        column,
        data_bindings: config.local.dataBindings,
      });
      if (isRefusal(r)) return r;
      const where = (r as { sql?: unknown }).sql;
      if (typeof where !== "string")
        return unavailable("AUTHZ-OSO-006: list_query returned no sql");
      return { ok: true, kind: "sql", where };
    },
  };
}
