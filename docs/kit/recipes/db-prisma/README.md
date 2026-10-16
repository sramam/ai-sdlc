# Recipe: `db-prisma` (the alternative)

Prisma 7 on Workers through Hyperdrive. It works (spike evidence in
[../../spike-2026-10.md](../../spike-2026-10.md)); choose it over
[`db-drizzle`](../db-drizzle/) when the project wants Prisma's client
extensions (door_nexa's organization-scoped client) more than a small Worker.
Measured on the same app: 1,497 KiB gzip against Drizzle's 307 KiB, and a
first request of about 60–75 ms against 25–37 ms under local `wrangler dev`.

| file                   | is                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma` | `provider = "prisma-client"`, `runtime = "workerd"`, no `url` in the datasource                             |
| `prisma.config.ts`     | the datasource URL from `DATABASE_URL`, and the migrations path                                             |
| `src/client.ts`        | `withDb`: `PrismaClient({ adapter: new PrismaPg({ connectionString }) })` per request, then `$disconnect()` |

- Pin **7.x** (`prisma@7.10.1`, `@prisma/client@7.10.1`, `@prisma/adapter-pg@7.10.1`).
  In October 2026 npm's `latest` tag for `prisma` pointed at `8.0.0-rc.23`.
- pnpm blocks Prisma's install scripts until approved (`pnpm approve-builds`);
  `prisma generate` still works.
- Cloudflare's own Prisma-with-Hyperdrive page still shows the Prisma 6 shape
  (`prisma-client-js`, `previewFeatures = ["driverAdapters"]`). Use Prisma's
  v7 Cloudflare page and this recipe instead.
- Migrations: `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
  for the first, `prisma migrate dev --create-only` against localdb after that;
  applied by `"migrate": "pnpm --filter @app/web exec prisma migrate deploy"` in
  `localdb.databases`.
