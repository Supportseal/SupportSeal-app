import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";

import { PrismaClient } from "@/generated/prisma/client";
import { PRISMA_TEST_CLIENT_GLOBAL_KEY } from "@/lib/prisma-constants";

export type TestDb = {
  pglite: PGlite;
  prisma: PrismaClient;
};

/** Boot an in-memory PGlite, replay prisma/migrations, share the client via globalThis. */
export async function startTestDb(): Promise<TestDb> {
  const pglite = new PGlite("memory://");
  await pglite.waitReady;

  const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(migrationsDir);
  } catch {
    entries = [];
  }
  for (const entry of entries.filter((e) => /^\d+_/u.test(e)).sort()) {
    const sql = await fs.readFile(path.join(migrationsDir, entry, "migration.sql"), "utf8");
    await pglite.exec(sql);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
  (globalThis as Record<string, unknown>)[PRISMA_TEST_CLIENT_GLOBAL_KEY] = prisma;
  return { pglite, prisma };
}

export async function stopTestDb({ pglite, prisma }: TestDb): Promise<void> {
  delete (globalThis as Record<string, unknown>)[PRISMA_TEST_CLIENT_GLOBAL_KEY];
  await prisma.$disconnect();
  await pglite.close();
}

/** Create a user directly (bypasses better-auth; for tenant fixtures). */
export async function createTestUser(
  prisma: PrismaClient,
  input: { id?: string; name?: string; email: string },
) {
  return prisma.user.create({
    data: {
      id: input.id ?? `user_${input.email}`,
      name: input.name ?? input.email.split("@")[0],
      email: input.email,
      emailVerified: false,
    },
  });
}
