import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { PRISMA_TEST_CLIENT_GLOBAL_KEY } from "@/lib/prisma-constants";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** Production-only module cache (dev/tests use `globalForPrisma`). */
let prismaProduction: PrismaClient | undefined;

function getPrisma(): PrismaClient {
  const testClient = (globalThis as Record<string, unknown>)[PRISMA_TEST_CLIENT_GLOBAL_KEY] as
    | PrismaClient
    | undefined;
  if (testClient) return testClient;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString) {
    if (process.env.NODE_ENV === "production") {
      prismaProduction ??= new PrismaClient({ adapter: new PrismaPg(connectionString) });
      return prismaProduction;
    }
    globalForPrisma.prisma ??= new PrismaClient({ adapter: new PrismaPg(connectionString) });
    return globalForPrisma.prisma;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }

  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  throw new Error(
    "Dev database not initialised yet. It is booted by instrumentation.ts at server start; " +
      "restart the dev server or run scripts through initDevDb().",
  );
}

/**
 * App-wide Prisma client. Lazily resolves on first property access so
 * `next build` can load route modules without a database until a handler
 * actually runs.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrisma();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/** Resolve the concrete PrismaClient (used by better-auth and scripts). */
export function resolvePrisma(): PrismaClient {
  return getPrisma();
}
