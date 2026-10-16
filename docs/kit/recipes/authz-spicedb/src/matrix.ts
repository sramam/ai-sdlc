// The matrix test's generator: every persona × capability cell of the access
// model is a case, against a fixed example world. A policy change that alters
// a cell fails until access-model.md changes with it (security.md).
//
// Identical in authz-oso and authz-spicedb; only the engine differs.
import type { AuthzCaller, ResourceRef } from "./authz";

export type Cell = "yes" | "no" | "own";
export type Row = { capability: string; resource: string; cells: Record<string, Cell> };

/** Read the `| capability | resource | <persona>… |` table out of access-model.md. */
export function parseAccessModel(markdown: string): Row[] {
  const lines = markdown.split("\n").filter((l) => l.trim().startsWith("|"));
  const header = cellsOf(lines[0] ?? "");
  if (header[0] !== "capability" || header[1] !== "resource") {
    throw new Error("MATRIX-001: the table must start | capability | resource | <persona>… |");
  }
  const personas = header.slice(2);
  return lines.slice(2).map((line) => {
    const [capability, resource, ...values] = cellsOf(line);
    const cells: Record<string, Cell> = {};
    personas.forEach((p, i) => {
      const v = values[i];
      if (v !== "yes" && v !== "no" && v !== "own") {
        throw new Error(`MATRIX-002: ${capability} × ${p} is "${v}"; expected yes | no | own`);
      }
      cells[p] = v;
    });
    return { capability: capability!, resource: resource!, cells };
  });
}

const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** The example world every engine is loaded with (see each recipe's fixtures). */
export const WORLD = {
  orgs: { a: "org-a", b: "org-b" },
  users: { admin: "u-admin", member: "u-member", outsider: "u-outsider" },
  memberships: [
    { userId: "u-admin", orgId: "org-a", role: "admin" },
    { userId: "u-member", orgId: "org-a", role: "member" },
    { userId: "u-outsider", orgId: "org-b", role: "admin" },
  ],
  projects: [
    { id: "p-own", orgId: "org-a", createdBy: "u-member" }, // the member's own
    { id: "p-other", orgId: "org-a", createdBy: "u-admin" },
    { id: "p-b", orgId: "org-b", createdBy: "u-outsider" },
  ],
} as const;

export const callerFor = (persona: string): AuthzCaller => {
  const userId = (WORLD.users as Record<string, string>)[persona];
  if (!userId) throw new Error(`MATRIX-003: no persona ${persona} in WORLD`);
  const m = WORLD.memberships.find((x) => x.userId === userId)!;
  return { userId, tenantId: m.orgId };
};

export type Case = {
  name: string;
  persona: string;
  action: string;
  resource: ResourceRef;
  allowed: boolean;
};

/** One check per (cell, resource in org a) — `own` splits into an allow and a refuse. */
export function checkCases(rows: Row[]): Case[] {
  const out: Case[] = [];
  for (const row of rows) {
    for (const [persona, cell] of Object.entries(row.cells)) {
      const targets: [ResourceRef, boolean][] =
        row.resource === "Organization"
          ? [[{ type: "Organization", id: WORLD.orgs.a }, cell === "yes"]]
          : [
              [{ type: row.resource, id: "p-own" }, cell !== "no"],
              [{ type: row.resource, id: "p-other" }, cell === "yes"],
            ];
      for (const [resource, allowed] of targets) {
        out.push({
          name: `${persona} ${allowed ? "may" : "may not"} ${row.capability} ${resource.id}`,
          persona,
          action: row.capability,
          resource,
          allowed,
        });
      }
    }
  }
  return out;
}

/** What list filtering must return, restricted to organization a's projects. */
export function listCases(rows: Row[]) {
  return rows
    .filter((r) => r.resource === "Project")
    .flatMap((row) =>
      Object.entries(row.cells).map(([persona, cell]) => ({
        name: `${persona} lists ${row.capability}`,
        persona,
        action: row.capability,
        visibleInA: cell === "yes" ? ["p-other", "p-own"] : cell === "own" ? ["p-own"] : [],
      })),
    );
}
