#!/usr/bin/env node
/**
 * Apply prisma/migrations to the development PGlite database
 * (.dev-data/pglite.db). This is the dev-only companion to
 * `npm run db:migrate` (prisma migrate deploy), which targets a real
 * Postgres DATABASE_URL. Migrations are authored with the Prisma CLI
 * against Postgres; this script replays the same SQL on PGlite.
 */
import fs from "node:fs/promises";
import path from "node:path";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");

async function run() {
  const { PGlite } = await import("@electric-sql/pglite");
  const dbPath = path.isAbsolute(process.env.PGLITE_PATH?.trim() || "")
    ? process.env.PGLITE_PATH.trim()
    : path.join(process.cwd(), process.env.PGLITE_PATH?.trim() || path.join(".dev-data", "pglite.db"));
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const db = new PGlite(dbPath);
  await db.waitReady;

  await db.exec(`CREATE TABLE IF NOT EXISTS dev_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT now()
  )`);

  const applied = new Set(
    (await db.query("SELECT id FROM dev_migrations")).rows.map((r) => r.id),
  );

  let entries = [];
  try {
    entries = await fs.readdir(MIGRATIONS_DIR);
  } catch {
    console.log("No migrations directory yet; nothing to apply.");
    await db.close();
    return;
  }

  const pending = entries
    .filter((e) => /^\d+_/u.test(e))
    .sort()
    .filter((e) => !applied.has(e));

  if (pending.length === 0) {
    console.log("Dev database is up to date.");
    await db.close();
    return;
  }

  for (const migration of pending) {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, migration, "migration.sql"), "utf8");
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db.query("INSERT INTO dev_migrations (id) VALUES ($1)", [migration]);
      await db.exec("COMMIT");
      console.log(`applied ${migration}`);
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }

  await db.close();
  console.log("Dev database migrated.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
