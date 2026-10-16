// No dual writes (security.md): a relationship is enqueued in the SAME database
// transaction as the row it describes, and a relay writes it to SpiceDB
// afterwards. TOUCH and DELETE are idempotent, so a relay that dies after
// SpiceDB accepted the write but before marking the rows simply sends them again.
//
// Run `relay` from a Queue consumer or a Cron Trigger, and after a write that a
// read must observe at once (pass the returned ZedToken as `atLeastAsFresh`).
import { and, asc, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { AuthzRefusal } from "./authz";
import { spicedbClient, type SpiceDbConfig } from "./spicedb";

export const authzOutbox = pgTable("authz_outbox", {
  id: serial("id").primaryKey(),
  op: text("op", { enum: ["touch", "delete"] }).notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  relation: text("relation").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  relayedAt: timestamp("relayed_at", { withTimezone: true }),
  zedToken: text("zed_token"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<PgQueryResultHKT, any, any>;

export type RelationshipOp = Omit<
  typeof authzOutbox.$inferInsert,
  "id" | "createdAt" | "relayedAt" | "zedToken" | "attempts" | "lastError"
>;

/** Enqueue inside the caller's transaction, beside the row the relationships describe. */
export async function enqueue(tx: Db, ops: RelationshipOp[]): Promise<void> {
  if (ops.length) await tx.insert(authzOutbox).values(ops);
}

/** Relay pending rows in id order, as ONE WriteRelationships call (atomic in SpiceDB). */
export async function relay(
  db: Db,
  config: SpiceDbConfig,
  { batch = 100 }: { batch?: number } = {},
): Promise<{ ok: true; relayed: number; zedToken: string | null } | AuthzRefusal> {
  const call = spicedbClient(config);
  return db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(authzOutbox)
      .where(isNull(authzOutbox.relayedAt))
      .orderBy(asc(authzOutbox.id))
      .limit(batch)
      .for("update", { skipLocked: true });
    if (!pending.length) return { ok: true as const, relayed: 0, zedToken: null };

    const res = await call("/v1/relationships/write", {
      updates: pending.map((o) => ({
        operation: o.op === "touch" ? "OPERATION_TOUCH" : "OPERATION_DELETE",
        relationship: {
          resource: { objectType: o.resourceType, objectId: o.resourceId },
          relation: o.relation,
          subject: { object: { objectType: o.subjectType, objectId: o.subjectId } },
        },
      })),
    });
    const ids = sql`${authzOutbox.id} in (${sql.join(
      pending.map((p) => sql`${p.id}`),
      sql`, `,
    )})`;
    if (!(res instanceof Response)) {
      await tx
        .update(authzOutbox)
        .set({ attempts: sql`${authzOutbox.attempts} + 1`, lastError: res.detail })
        .where(and(ids, isNull(authzOutbox.relayedAt)));
      return res;
    }
    const body = (await res.json()) as { writtenAt?: { token?: string } };
    const zedToken = body.writtenAt?.token ?? null;
    await tx.update(authzOutbox).set({ relayedAt: new Date(), zedToken }).where(ids);
    return { ok: true as const, relayed: pending.length, zedToken };
  });
}

/** The example's mapping from rows to relationships. Each project needs both. */
export const projectRelationships = (p: {
  id: string;
  orgId: string;
  createdBy: string;
}): RelationshipOp[] => [
  {
    op: "touch",
    resourceType: "project",
    resourceId: p.id,
    relation: "parent",
    subjectType: "organization",
    subjectId: p.orgId,
  },
  {
    op: "touch",
    resourceType: "project",
    resourceId: p.id,
    relation: "creator",
    subjectType: "user",
    subjectId: p.createdBy,
  },
];

export const membershipRelationship = (m: {
  userId: string;
  orgId: string;
  role: string;
}): RelationshipOp => ({
  op: "touch",
  resourceType: "organization",
  resourceId: m.orgId,
  relation: m.role,
  subjectType: "user",
  subjectId: m.userId,
});

export const pendingCount = async (db: Db) =>
  (await db.select({ id: authzOutbox.id }).from(authzOutbox).where(isNull(authzOutbox.relayedAt)))
    .length;
