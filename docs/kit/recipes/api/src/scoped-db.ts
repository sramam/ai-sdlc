// The scoped client: the ONE place the tenant filter is applied. Capabilities
// get this, never the raw database, so "which rows" cannot be forgotten.
//
// Drizzle has no client extensions (Prisma's scoping hook), so scoping is a
// thin wrapper: every read and write on a tenant table is conjoined with
// `tenant_id = caller.tenantId`, and inserts have it set. A table without a
// `tenantId` column cannot be passed in (the type refuses it).
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgDatabase, PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core";
import type { ListFilter } from "./authz";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT, any, any>;

export type TenantTable = PgTable & { tenantId: PgColumn };

export interface ScopedDb {
  readonly tenantId: string;
  select<T extends TenantTable>(table: T, where?: SQL): Promise<T["$inferSelect"][]>;
  insert<T extends TenantTable>(
    table: T,
    values: Omit<T["$inferInsert"], "tenantId">,
  ): Promise<void>;
  update<T extends TenantTable>(
    table: T,
    set: Partial<Omit<T["$inferInsert"], "tenantId">>,
    where: SQL,
  ): Promise<number>;
  delete<T extends TenantTable>(table: T, where: SQL): Promise<number>;
  transaction<R>(fn: (tx: ScopedDb) => Promise<R>): Promise<R>;
}

export function scopedDb(db: Db, tenantId: string): ScopedDb {
  if (!tenantId) throw new Error("SCOPE-001: a scoped client needs a tenant"); // "" would match nothing, silently
  const inTenant = <T extends TenantTable>(t: T, where?: SQL) =>
    and(eq(t.tenantId, tenantId), where) as SQL;

  return {
    tenantId,
    select<T extends TenantTable>(table: T, where?: SQL) {
      return db
        .select()
        .from(table as PgTable)
        .where(inTenant(table, where)) as unknown as Promise<T["$inferSelect"][]>;
    },
    async insert<T extends TenantTable>(table: T, values: Omit<T["$inferInsert"], "tenantId">) {
      await db.insert(table).values({ ...values, tenantId } as T["$inferInsert"]);
    },
    /** Returns how many rows changed, so "no such row in your tenant" is visible to the caller. */
    async update<T extends TenantTable>(
      table: T,
      set: Partial<Omit<T["$inferInsert"], "tenantId">>,
      where: SQL,
    ): Promise<number> {
      const rows = await db
        .update(table)
        .set(set as never)
        .where(inTenant(table, where))
        .returning({ one: sql`1` });
      return rows.length;
    },
    async delete<T extends TenantTable>(table: T, where: SQL): Promise<number> {
      const rows = await db
        .delete(table)
        .where(inTenant(table, where))
        .returning({ one: sql`1` });
      return rows.length;
    },
    /** Run several writes atomically, still scoped. */
    transaction<R>(fn: (tx: ScopedDb) => Promise<R>): Promise<R> {
      return db.transaction((tx) => fn(scopedDb(tx as unknown as Db, tenantId)));
    },
  };
}

/**
 * The policy engine's list filter, as a WHERE clause over the resource's id
 * column. Applied in the query, never in memory (security.md § both checks).
 */
export function whereAllowed(idColumn: PgColumn, filter: ListFilter): SQL {
  if (filter.kind === "ids") {
    if (!filter.ids.length) return sql`false`;
    return sql`${idColumn} in (${sql.join(
      filter.ids.map((id) => sql`${id}`),
      sql`, `,
    )})`;
  }
  // Oso local authorization returns SQL over the column it was given
  // (`project.id`); it quotes literals itself (tested in authz-oso).
  return sql.raw(`(${filter.where})`);
}
