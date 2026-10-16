// The example capabilities. Each is a manifest entry: name, schemas, effect, access.
import { randomUUID } from "node:crypto";
import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";
import { capability } from "../capability";
import { refuse } from "../refusal";
import { whereAllowed } from "../scoped-db";
import { project } from "./schema";

// The input schemas are the forms' resolvers too (ui recipe), so they must not
// import the database package. `strictObject`: an unexpected key is refused by name.
const name = z.string().trim().min(2, "At least 2 characters.").max(80, "At most 80 characters.");

export const projectCreate = capability({
  name: "project.create",
  summary: "Create a project in the active organization.",
  effect: "write",
  input: z.strictObject({ name }),
  output: z.object({ ok: z.literal(true), id: z.string() }),
  access: {
    kind: "check",
    action: "project.create",
    resource: (_input, caller) => ({ type: "Organization", id: caller.tenantId }),
  },
  async run({ caller, input, db }) {
    const id = randomUUID();
    try {
      await db.insert(project, { id, name: input.name, createdBy: caller.userId });
    } catch (error) {
      if (isUniqueViolation(error))
        return refuse("CONFLICT", "A project with that name exists.", "name");
      throw error;
    }
    return { ok: true as const, id };
  },
});

export const projectList = capability({
  name: "project.list",
  summary: "Projects the caller may read, by name.",
  effect: "read",
  input: z.strictObject({ search: z.string().trim().max(80).optional() }),
  output: z.object({
    ok: z.literal(true),
    items: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  access: { kind: "list", action: "project.read", resourceType: "Project" },
  async run({ input, db, filter }) {
    const rows = await db.select(
      project,
      and(
        whereAllowed(project.id, filter!),
        input.search ? ilike(project.name, `%${input.search}%`) : undefined,
      ),
    );
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true as const, items: rows.map((r) => ({ id: r.id, name: r.name })) };
  },
});

export const projectRename = capability({
  name: "project.rename",
  summary: "Rename a project.",
  effect: "write",
  input: z.strictObject({ id: z.string().min(1), name }),
  output: z.object({ ok: z.literal(true), id: z.string(), name: z.string() }),
  access: {
    kind: "check",
    action: "project.update",
    resource: (input) => ({ type: "Project", id: input.id }),
    exists: async (db, input) => (await db.select(project, eq(project.id, input.id))).length > 0,
  },
  async run({ input, db }) {
    try {
      const changed = await db.update(project, { name: input.name }, eq(project.id, input.id));
      if (changed === 0) return refuse("NOT_FOUND", "That project no longer exists.");
    } catch (error) {
      if (isUniqueViolation(error))
        return refuse("CONFLICT", "A project with that name exists.", "name");
      throw error;
    }
    return { ok: true as const, id: input.id, name: input.name };
  },
});

/** Postgres 23505, through Drizzle's wrapper (`cause`) or not. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
