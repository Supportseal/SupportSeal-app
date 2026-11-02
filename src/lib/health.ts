import { NextResponse } from "next/server";

/**
 * Process configuration check shared by both health probes. Reports
 * unhealthy when the auth secret is missing in production: every page would
 * answer 500 (getAuth throws), so the container must not look healthy.
 */
export function misconfiguredResponse(): NextResponse | null {
  if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_SECRET?.trim()) {
    return NextResponse.json(
      { status: "misconfigured", auth: "BETTER_AUTH_SECRET is not set" },
      { status: 503 },
    );
  }
  return null;
}
