// Prisma 7 through Hyperdrive: @prisma/adapter-pg over the per-request
// connection string. One client per request, disconnected when it is done.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

export type ConnectionSource = { connectionString: string };

export async function withDb<T>(
  source: ConnectionSource,
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: source.connectionString }),
  });
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
