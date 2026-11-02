import { NextResponse } from "next/server";
import { misconfiguredResponse } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * Liveness for the container HEALTHCHECK: the process answers and is
 * configured. Deliberately never touches the database, so frequent probes
 * let a scale-to-zero database suspend while nobody uses the app.
 */
export function GET() {
  return misconfiguredResponse() ?? NextResponse.json({ status: "ok" });
}
