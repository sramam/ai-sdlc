// A person's relationships: a role in a tenant. Exactly one is active, chosen
// explicitly, and it decides both the shell and the row scope (access-model.md).
export type Relationship = {
  id: string;
  tenantName: string;
  role: string;
  /** The shell this role lands in. */
  shell: "customer" | "backoffice";
  lastUsedAt: string;
};

/** Most recent first, as the switcher and ⌘K list them. */
export const byRecent = (rs: Relationship[]) =>
  [...rs].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
