import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Container health. Reports unhealthy when the auth secret is missing in
 * production: every page would answer 500 (getAuth throws), so the
 * container must not look healthy to Docker or a load balancer.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_SECRET?.trim()) {
    return NextResponse.json(
      { status: "misconfigured", auth: "BETTER_AUTH_SECRET is not set" },
      { status: 503 },
    );
  }
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
