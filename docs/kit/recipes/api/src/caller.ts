// Who is acting. RESOLVED by a binding from a verified session and the
// person's ACTIVE relationship, never read from a request body: an input that
// could carry a tenant or a role would let the caller choose its own authority.
//
// `Caller` is branded, so the only way to hold one is `resolveCaller`. A binding
// that builds `{ tenantId: body.tenantId, … }` does not type-check.
import { refuse, type Refusal } from "./refusal";

declare const RESOLVED: unique symbol;

/** The row-scope relationship below the tenant, when the role carries one (a customer, an owner). */
export type Party = { readonly kind: string; readonly id: string };

export type Caller = {
  readonly userId: string;
  /** The active relationship's tenant. Every scoped query is conjoined with it. */
  readonly tenantId: string;
  /** The role carried by the RELATIONSHIP, not the person. */
  readonly role: string;
  /** Narrows rows within the tenant; null for staff-of-the-tenant roles. */
  readonly party: Party | null;
  readonly [RESOLVED]: true;
};

/** What the auth library verified: a session, and nothing the client said about itself. */
export type VerifiedSession = { readonly userId: string };

/** The active relationship, read from the database by the binding (see access-model.md § switching). */
export type ActiveRelationship = {
  readonly tenantId: string;
  readonly role: string;
  readonly party: Party | null;
};

/** Roles whose row scope is a party. A role listed here with no party is a binding defect. */
export const PARTY_ROLES: readonly string[] = ["customer"];

export function resolveCaller(
  session: VerifiedSession,
  active: ActiveRelationship | null,
): Caller | Refusal {
  // No active relationship: the person chooses one first (a precondition, ux.md § Shells).
  if (!active) return refuse("FORBIDDEN", "Choose an organization to continue.");
  if (PARTY_ROLES.includes(active.role) && !active.party) {
    // Loud: without a party a customer would see the whole tenant.
    throw new Error(`CALLER-001: role ${active.role} carries row scope and no party was resolved`);
  }
  return { userId: session.userId, ...active } as Caller;
}
