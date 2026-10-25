import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Database clock/timezone alignment guard (ADR-0003 spike finding, issue #2):
 * message cursors compare app-clock Dates against database-stored
 * timestamps. A database session running a non-UTC timezone skewed Prisma's
 * naive-timestamp round-trip by hours in the spike, which made streams
 * silently drop messages. The docker-compose database defaults to UTC; this
 * check makes a misconfigured external database visible at boot instead of
 * losing messages quietly.
 */

const CLOCK_DRIFT_TOLERANCE_MS = 5 * 60 * 1000;
const TIMEZONE_TOLERANCE_SECONDS = 60;

export type DbAlignmentResult =
  | { ok: true }
  | { ok: false; warnings: string[] };

type AlignmentRow = {
  /** Database server clock as epoch seconds (timestamptz, unambiguous). */
  db_epoch: number;
  /** Session wall-clock offset from UTC in seconds, computed entirely in SQL. */
  tz_offset_seconds: number;
};

export function evaluateDbAlignment(input: {
  dbEpochMs: number;
  tzOffsetSeconds: number;
  appEpochMs: number;
}): DbAlignmentResult {
  const warnings: string[] = [];
  const driftMs = Math.abs(input.dbEpochMs - input.appEpochMs);
  if (driftMs > CLOCK_DRIFT_TOLERANCE_MS) {
    warnings.push(
      `database clock differs from the app clock by ${Math.round(driftMs / 1000)}s; ` +
        "message cursors can skip or duplicate messages until the clocks agree",
    );
  }
  if (Math.abs(input.tzOffsetSeconds) > TIMEZONE_TOLERANCE_SECONDS) {
    const minutes = Math.round(Math.abs(input.tzOffsetSeconds) / 60);
    warnings.push(
      `database session timezone is not UTC (offset ${input.tzOffsetSeconds >= 0 ? "+" : "-"}${minutes}min); ` +
        "SupportSeal requires timezone=UTC (the docker-compose database defaults to UTC); " +
        "conversation streams can silently drop messages otherwise",
    );
  }
  return warnings.length === 0 ? { ok: true } : { ok: false, warnings };
}

/** Probe the live database; computed in SQL so driver parsing cannot mask a skew. */
export async function checkDbAlignment(
  prisma: PrismaClient,
  appEpochMs: number = Date.now(),
): Promise<DbAlignmentResult> {
  const rows = await prisma.$queryRaw<AlignmentRow[]>`
    SELECT EXTRACT(EPOCH FROM now())::float8 AS db_epoch,
           EXTRACT(EPOCH FROM (now()::timestamp - (now() AT TIME ZONE 'UTC')))::float8 AS tz_offset_seconds
  `;
  const row = rows[0];
  if (!row || typeof row.db_epoch !== "number" || typeof row.tz_offset_seconds !== "number") {
    return { ok: false, warnings: ["database clock alignment probe returned no usable result"] };
  }
  return evaluateDbAlignment({
    dbEpochMs: row.db_epoch * 1000,
    tzOffsetSeconds: row.tz_offset_seconds,
    appEpochMs,
  });
}
