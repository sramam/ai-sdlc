// A capability: one implementation, called by every binding (server function,
// HTTP, MCP, agent tool). `invoke` is the only way to run one, and it always:
//
//   1. validates the input with the capability's own schema → INVALID + field
//   2. scopes: for a row in the input, is it in the caller's tenant? → NOT_FOUND
//   3. asks "may" through `@scope/authz`, or gets the list filter   → FORBIDDEN / UNAVAILABLE
//   4. runs against the SCOPED client, never the raw one
//
// Outputs are identifiers and the facts that changed, never rows. They are
// declared (OpenAPI, MCP, the form) and asserted in the contract suite, not
// parsed at runtime.
import type { z } from "zod";
import type { Authz, ListFilter, ResourceRef } from "./authz";
import type { Caller } from "./caller";
import { refuse, type Refusal } from "./refusal";
import { scopedDb, type Db, type ScopedDb } from "./scoped-db";

export type Effect = "read" | "write";

export type Access<I> =
  /** One resource: the engine's check. `exists` (the scope check) runs first when given. */
  | {
      kind: "check";
      action: string;
      resource: (input: I, caller: Caller) => ResourceRef;
      exists?: (db: ScopedDb, input: I) => Promise<boolean>;
    }
  /** A list: the engine's filter, handed to `run` to put in the query. */
  | { kind: "list"; action: string; resourceType: string };

export type Context<I> = {
  caller: Caller;
  input: I;
  db: ScopedDb;
  /** Present for `list` access; null otherwise. */
  filter: ListFilter | null;
};

export type Capability<IS extends z.ZodType = z.ZodType, OS extends z.ZodType = z.ZodType> = {
  /** `<entity>.<verb>`, unique across the manifest. */
  name: string;
  summary: string;
  effect: Effect;
  input: IS;
  /** The success shape, including `ok: true`. */
  output: OS;
  access: Access<z.output<IS>>;
  run(ctx: Context<z.output<IS>>): Promise<z.output<OS> | Refusal>;
};

/**
 * Declares a capability. The name is kept as a literal type, so the manifest's
 * type names every capability and the SDK binding can be typed from it alone.
 */
export function capability<const N extends string, IS extends z.ZodType, OS extends z.ZodType>(
  def: Capability<IS, OS> & { name: N },
): Capability<IS, OS> & { name: N } {
  return def;
}

export type Deps = {
  db: Db;
  authz: Authz;
  /** The binding's span helper (telemetry recipe's `inSpan`), so the port imports no runtime. */
  around?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

export async function invoke<IS extends z.ZodType, OS extends z.ZodType>(
  cap: Capability<IS, OS>,
  deps: Deps,
  caller: Caller,
  raw: unknown,
): Promise<z.output<OS> | Refusal> {
  const go = async (): Promise<z.output<OS> | Refusal> => {
    const parsed = cap.input.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      // An unexpected key (strict schema) names the key, so `tenantId` lands on itself.
      const keys = (issue as { keys?: string[] }).keys;
      const field = keys?.[0] ?? issue.path.join(".");
      return refuse("INVALID", issue.message, field || undefined);
    }
    const input = parsed.data as z.output<IS>;
    const db = scopedDb(deps.db, caller.tenantId);

    let filter: ListFilter | null = null;
    if (cap.access.kind === "check") {
      if (cap.access.exists && !(await cap.access.exists(db, input))) {
        return refuse("NOT_FOUND", "That record does not exist."); // not asked: its tenant is not yours
      }
      const d = await deps.authz.authorize(
        caller,
        cap.access.action,
        cap.access.resource(input, caller),
      );
      if (!d.ok) return refuse(d.code, d.code === "FORBIDDEN" ? "You may not do that." : d.detail);
    } else {
      const f = await deps.authz.listFilter(caller, cap.access.action, cap.access.resourceType);
      if (!f.ok)
        return refuse(f.code, f.code === "FORBIDDEN" ? "You may not see these." : f.detail);
      filter = f;
    }
    return cap.run({ caller, input, db, filter });
  };
  return deps.around ? deps.around(cap.name, go) : go();
}
