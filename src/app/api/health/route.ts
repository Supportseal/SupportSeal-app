import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { misconfiguredResponse } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * Readiness: configuration plus a database round trip. For humans, upgrade
 * checks and external monitors. The container HEALTHCHECK uses
 * `/api/health/live` instead: a query every 30 s keeps a scale-to-zero
 * database (Neon) awake around the clock.
 */
export async function GET() {
  const misconfigured = misconfiguredResponse();
  if (misconfigured) return misconfigured;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "ok" });
  } catch {
    return NextResponse.json(
      { status: "degraded", database: "unavailable" },
      { status: 503 },
    );
  }
}
