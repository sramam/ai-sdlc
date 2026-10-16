// The `@scope/authz` interface. Identical in authz-oso and authz-spicedb (and
// mirrored in api/src/authz.ts): capabilities depend on this, never on an engine.
//
// Three answers, never two: allowed, refused, and could-not-ask. The third is
// a refusal too (security.md: an unreachable engine means refuse), but with
// its own code, so a binding can tell "you may not" from "we could not check".

/** What the engine needs from a Caller. The api's `Caller` satisfies it. */
export type AuthzCaller = { readonly userId: string; readonly tenantId: string };

export type ResourceRef = { readonly type: string; readonly id: string };

export type AuthzRefusal = {
  ok: false;
  /** FORBIDDEN: the policy says no. UNAVAILABLE: the engine could not be asked. */
  code: "FORBIDDEN" | "UNAVAILABLE";
  detail: string;
};

export type Decision = { ok: true } | AuthzRefusal;

/**
 * Which rows of `resourceType` the caller may act on. Applied in the query,
 * never by fetching everything and filtering in memory.
 * - `ids`: the engine enumerated them (SpiceDB LookupResources, Oso `list`)
 * - `sql`: a WHERE fragment over the resource's id column (Oso local authorization)
 */
export type ListFilter =
  { ok: true; kind: "ids"; ids: readonly string[] } | { ok: true; kind: "sql"; where: string };

export interface Authz {
  authorize(caller: AuthzCaller, action: string, resource: ResourceRef): Promise<Decision>;
  listFilter(
    caller: AuthzCaller,
    action: string,
    resourceType: string,
  ): Promise<ListFilter | AuthzRefusal>;
}

/**
 * Default deny for the vocabulary: the actions each resource type has, declared
 * once. An action or type not listed is refused before the engine is asked, so
 * a typo cannot reach a policy that happens to answer yes.
 */
export type ActionCatalogue = Readonly<Record<string, readonly string[]>>;

export function checkVocabulary(
  catalogue: ActionCatalogue,
  action: string,
  resourceType: string,
): AuthzRefusal | null {
  const actions = catalogue[resourceType];
  if (!actions) return forbidden(`unknown resource type ${resourceType}`);
  if (!actions.includes(action)) return forbidden(`unknown action ${action} on ${resourceType}`);
  return null;
}

export const forbidden = (detail: string): AuthzRefusal => ({
  ok: false,
  code: "FORBIDDEN",
  detail,
});
export const unavailable = (detail: string): AuthzRefusal => ({
  ok: false,
  code: "UNAVAILABLE",
  detail,
});
