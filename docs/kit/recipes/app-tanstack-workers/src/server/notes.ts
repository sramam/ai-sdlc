import { createServerFn } from "@tanstack/react-start";
import { desc } from "drizzle-orm";
import { withDb } from "../db/client";
import { note } from "../db/schema";
import { inSpan } from "../telemetry/span";
import { workersTracer } from "../telemetry/workers-tracer";
import { appEnv } from "./env";

export const listNotesFn = createServerFn({ method: "GET" }).handler(async () =>
  inSpan(workersTracer, "note.list", { "app.capability": "note.list" }, () =>
    withDb(appEnv().HYPERDRIVE, async (db) => {
      const rows = await db.select().from(note).orderBy(desc(note.id)).limit(10);
      return { ok: true as const, notes: rows.map((r) => ({ id: r.id, body: r.body })) };
    }),
  ),
);
