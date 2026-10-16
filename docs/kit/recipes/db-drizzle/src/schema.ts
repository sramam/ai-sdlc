import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// The project's tables. The example table is the one the spike read back.
export const note = pgTable("note", {
  id: serial("id").primaryKey(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Better Auth's tables, generated (see auth-schema.ts).
export * from "./auth-schema";
