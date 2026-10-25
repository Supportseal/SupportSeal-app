import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { evaluateDbAlignment, checkDbAlignment } from "@/lib/db-alignment";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

describe("database clock/timezone alignment (ADR-0003 spike follow-up)", () => {
  it("accepts aligned clocks", () => {
    const now = Date.now();
    expect(
      evaluateDbAlignment({ dbEpochMs: now, tzOffsetSeconds: 0, appEpochMs: now }),
    ).toEqual({ ok: true });
  });

  it("warns on database clock drift beyond the tolerance", () => {
    const now = Date.now();
    const result = evaluateDbAlignment({
      dbEpochMs: now + 6 * 60 * 1000,
      tzOffsetSeconds: 0,
      appEpochMs: now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warnings.join(" ")).toContain("clock differs");
  });

  it("warns on a non-UTC session timezone (the spike failure mode)", () => {
    const now = Date.now();
    const result = evaluateDbAlignment({
      dbEpochMs: now,
      tzOffsetSeconds: 8 * 60 * 60, // Australia/Perth, the spike's cluster
      appEpochMs: now,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.warnings.join(" ")).toContain("timezone is not UTC");
      expect(result.warnings.join(" ")).toContain("silently drop");
    }
  });

  it("tolerates small offsets (NTP drift, half-minute zones)", () => {
    const now = Date.now();
    expect(
      evaluateDbAlignment({ dbEpochMs: now - 60_000, tzOffsetSeconds: 30, appEpochMs: now }),
    ).toEqual({ ok: true });
  });

  it("probes a live UTC session as aligned and detects a non-UTC one", async () => {
    // PGlite inherits the host timezone; pin the session for determinism.
    await db.prisma.$executeRawUnsafe("SET TIME ZONE 'UTC'");
    expect(await checkDbAlignment(db.prisma)).toEqual({ ok: true });

    await db.prisma.$executeRawUnsafe("SET TIME ZONE 'Australia/Perth'");
    const skewed = await checkDbAlignment(db.prisma);
    expect(skewed.ok).toBe(false);
    if (!skewed.ok) expect(skewed.warnings.join(" ")).toContain("timezone is not UTC");

    await db.prisma.$executeRawUnsafe("SET TIME ZONE 'UTC'");
  });
});
