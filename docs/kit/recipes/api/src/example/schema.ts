import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// A tenant table: `tenantId` is what makes the scoped client accept it.
export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(), // opaque, never sequential (security.md § IDs)
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_tenant_name").on(t.tenantId, t.name)],
);
