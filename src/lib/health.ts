import { NextResponse } from "next/server";

/**
 * Process configuration check shared by both health probes. Reports
 * unhealthy when the auth secret or the database URL is missing in
 * production: every page would answer 500 (getAuth / the Prisma client
 * throws), so the container must not look healthy. Never connects.
 */
export function misconfiguredResponse(): NextResponse | null {
  if (process.env.NODE_ENV !== "production") return null;
  if (!process.env.BETTER_AUTH_SECRET?.trim()) {
    return NextResponse.json(
      { status: "misconfigured", auth: "BETTER_AUTH_SECRET is not set" },
      { status: 503 },
    );
  }
  if (!process.env.DATABASE_URL?.trim()) {
    return NextResponse.json(
      { status: "misconfigured", database: "DATABASE_URL is not set" },
      { status: 503 },
    );
  }
  return null;
}
