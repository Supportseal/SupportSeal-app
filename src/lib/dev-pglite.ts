import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";

import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const PGLITE_PATH = process.env.PGLITE_PATH?.trim() || ".dev-data/pglite.db";

/**
 * Boot the file-backed PGlite dev database and cache the PrismaClient on
 * globalThis so the whole app shares one connection. Called from
 * instrumentation.ts at dev-server start (and directly by scripts/tests).
 */
export async function initDevDb(): Promise<PrismaClient> {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  await fs.mkdir(path.dirname(PGLITE_PATH), { recursive: true });
  const pglite = new PGlite(PGLITE_PATH);
  await pglite.waitReady;

  const client = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
  globalForPrisma.prisma = client;
  return client;
}
