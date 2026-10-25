#!/usr/bin/env node
/** Manual visitor cleanup; dry-run by default. See docs/self-hosting.md. */
import type { PrismaClient } from "../src/generated/prisma/client";

import { DEFAULT_VISITOR_RETENTION_DAYS, purgeStaleVisitors } from "../src/lib/visitor-purge";

const USAGE = `Usage: npm run db:purge-visitors [--] [--dry-run | --apply] [--days <n>]

Purges ChatVisitor rows that are ALL of:
  - not linked to a conversation, and never created one
  - anonymous: no email, name or external user id
  - not seen for the retention window (lastSeenAt older than --days)

Options:
  --dry-run   report the candidate count without deleting (the default)
  --apply     delete the candidate rows
  --days <n>  retention window in days: a whole number >= ${DEFAULT_VISITOR_RETENTION_DAYS} (default
              ${DEFAULT_VISITOR_RETENTION_DAYS}); the window can only be lengthened, never
              shortened below the conservative floor
  --help      show this help

Idempotent and safe to run alongside the live app. Identified visitors,
visitors with (or once had) conversations and visitors seen within the
window are never deleted.`;

class UsageError extends Error {}

const DAY_MS = 86_400_000;

function parseDays(raw: string): number {
  if (!/^\d+$/u.test(raw.trim())) {
    throw new UsageError("--days must be a whole number of days");
  }
  const days = Number(raw.trim());
  if (days < DEFAULT_VISITOR_RETENTION_DAYS) {
    throw new UsageError(`--days must be at least ${DEFAULT_VISITOR_RETENTION_DAYS} (the conservative retention floor)`);
  }
  return days;
}

function parseArgs(argv: string[]): { mode: "dry-run" | "apply"; days: number; help: boolean } {
  let apply = false;
  let dryRun = false;
  let days = 0;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--days") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError("--days requires a value");
      days = parseDays(value);
    } else if (arg.startsWith("--days=")) {
      days = parseDays(arg.slice("--days=".length));
    } else {
      // The offending value is not echoed: argv is untrusted input.
      throw new UsageError("unsupported argument (see --help)");
    }
  }
  if (apply && dryRun) throw new UsageError("--apply and --dry-run cannot be combined");
  return { mode: apply ? "apply" : "dry-run", days, help };
}

async function connect(): Promise<PrismaClient> {
  if (process.env.DATABASE_URL?.trim()) {
    const { resolvePrisma } = await import("../src/lib/prisma");
    return resolvePrisma();
  }
  if (process.env.NODE_ENV !== "production") {
    const { initDevDb } = await import("../src/lib/dev-pglite");
    return initDevDb();
  }
  throw new UsageError("DATABASE_URL is required to purge a production database.");
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const days = args.days || DEFAULT_VISITOR_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * DAY_MS);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new UsageError("the computed cutoff is not a finite date; refusing to run");
  }

  const prisma = await connect();
  try {
    const result = await purgeStaleVisitors(prisma, { cutoff, dryRun: args.mode === "dry-run" });
    console.log(`purge-stale-visitors: ${result.mode === "apply" ? "apply" : "dry-run (nothing deleted; pass --apply to delete)"}`);
    console.log(`retention: ${days} day(s) — cutoff ${cutoff.toISOString()} (rows last seen strictly before it)`);
    if (result.mode === "dry-run") {
      console.log(`would delete: ${result.matched} ChatVisitor row(s)`);
    } else {
      console.log(`deleted: ${result.deleted} of ${result.matched} candidate row(s) across ${result.batches} batch(es)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    if (error instanceof UsageError) {
      // Our own message and nothing from the caller's input or environment.
      console.error(`${error.message}\n\n${USAGE}`);
    } else {
      // Unexpected failures (database, connection) can embed credentials or
      // connection URLs: never dump them. If this happened mid-apply, earlier
      // batches may already be deleted — rerun the dry run to see the state.
      console.error("purge-stale-visitors: unexpected failure (details suppressed). If this was an --apply run, earlier batches may already be deleted; rerun the dry run to check.");
    }
    process.exit(1);
  });
