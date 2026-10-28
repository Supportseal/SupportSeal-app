import { NextResponse, type NextRequest } from "next/server";

import { SERVICE_PAUSED_CODE } from "@/lib/service-pause";
import { rateLimitFormSubmission } from "@/lib/widget-rate-limit";
import { createFormConversation, formKeyFromRequest, loadFormProduct } from "@/lib/widget";

export const dynamic = "force-dynamic";

/**
 * Keyed contact-form endpoint (issue #154): server-side Conversation
 * creation for websites whose contact form runs on their own backend. The
 * per-Product public form key (`fk_…`) replaces the widget's cookie/Origin
 * gates — this route deliberately checks neither, so posts work from any
 * server — and the explicit contact email attributes the Conversation, so
 * agent replies reach the visitor instead of a noreply sender. Workspace
 * isolation is unchanged (ADR-0001): the key itself scopes the Product,
 * archived Products are invisible, and every conversation lands in the
 * key's own Workspace.
 */
export async function POST(request: NextRequest) {
  if (!rateLimitFormSubmission(request)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const product = await loadFormProduct(formKeyFromRequest(request));
  if (!product) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const { email, message, name, subject } = payload ?? {};
  // JSON may carry any type; reject non-strings before they reach `.trim()`.
  if (
    typeof email !== "string" ||
    typeof message !== "string" ||
    !email ||
    !message ||
    (name != null && typeof name !== "string") ||
    (subject != null && typeof subject !== "string")
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createFormConversation({
    product,
    email,
    name,
    subject,
    message,
  });
  if (!result.ok) {
    // Key rotated or Product archived mid-request: same answer as the lookup.
    if (result.productGone) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // Free plan cutoff (src/lib/service-pause.ts): a stable code plus a
    // sentence the submitting server can show its visitor.
    if (result.paused) {
      return NextResponse.json({ error: SERVICE_PAUSED_CODE, message: result.error }, { status: 402 });
    }
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ticketRef: result.ticketRef }, { headers: { "cache-control": "no-store" } });
}
