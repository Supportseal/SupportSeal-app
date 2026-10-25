import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { sweepEscalations } from "@/lib/escalation";

export const dynamic = "force-dynamic";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Cron-callable escalation sweep (docs/design/escalation.md). Optional: the
 * in-app lazy sweep and timers work without it, but a scheduler hitting this
 * every minute gives tight latency on a quiet server. Disabled (404) unless
 * CRON_SECRET is set; authenticate with `Authorization: Bearer <secret>`.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "not found" }, { status: 404 });

  const presented = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!timingSafeEqual(digest(presented), digest(secret))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await sweepEscalations());
  } catch (error) {
    console.error("escalation sweep failed:", error);
    return NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }
}
