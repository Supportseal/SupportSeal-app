import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { rateLimitWidgetPreflight, rateLimitWidgetRequest } from "@/lib/widget-rate-limit";
import {
  isWidgetOriginAllowed,
  loadWidgetProduct,
  resolveVisitorSession,
  serviceOriginFrom,
  sessionOriginMatches,
  widgetRequestOriginOk,
  setVisitorEmail,
  touchVisitor,
  visitorTokenFromRequest,
  visitorListMessages,
  visitorSendMessage,
  type VisitorSession,
  type WidgetProduct,
} from "@/lib/widget";

export const dynamic = "force-dynamic";

const MIN_SEND_INTERVAL_MS = 800;

/**
 * Issue #82: the guard's product/session queries used to run before any
 * limit, so unauthenticated 401/404 responses hit the database
 * unthrottled. The IP-only preflight runs before the lookups; the
 * token-keyed buckets below still run after the guard, where the
 * product-scoped cookie-first identity is known (widget-rate-limit.ts) —
 * separate budgets, not a double charge of one bucket.
 */
function preflightLimit(request: NextRequest) {
  if (!rateLimitWidgetPreflight(request)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  return null;
}

/**
 * Explicit union so `"error" in guarded` narrows cleanly: inferred object
 * literal unions get optional-prop normalisation ({ product?: undefined }),
 * which leaks `undefined` into the handlers' return types.
 */
type GuardResult = { error: NextResponse } | { product: WidgetProduct; visitor: VisitorSession };

async function guard(request: NextRequest): Promise<GuardResult> {
  const key = request.nextUrl.searchParams.get("key") ?? "";
  const hostParam = request.nextUrl.searchParams.get("host");
  const product = await loadWidgetProduct(key);
  if (!product) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };

  const allowed = isWidgetOriginAllowed({
    productDomains: product.domains,
    hostParam,
    referer: request.headers.get("referer"),
    serviceOrigin: serviceOriginFrom(request.headers, request.nextUrl.origin),
    serviceIsProduction: process.env.NODE_ENV === "production",
    testToken: request.nextUrl.searchParams.get("testToken"),
    productId: product.id,
  });
  if (!allowed) return { error: NextResponse.json({ error: "origin_not_allowed" }, { status: 403 }) };

  const token = visitorTokenFromRequest(request, product.id);
  const visitor = await resolveVisitorSession(product, token);
  if (visitor && !sessionOriginMatches(visitor, hostParam)) {
    return { error: NextResponse.json({ error: "origin_not_allowed" }, { status: 403 }) };
  }
  if (!visitor) return { error: NextResponse.json({ error: "no_session" }, { status: 401 }) };

  return { product, visitor };
}

export async function POST(request: NextRequest) {
  if (!widgetRequestOriginOk(request.headers.get("origin"), serviceOriginFrom(request.headers, request.nextUrl.origin))) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  const limited = preflightLimit(request);
  if (limited) return limited;
  const guarded = await guard(request);
  if ("error" in guarded) return guarded.error;
  const { product, visitor } = guarded;
  if (!rateLimitWidgetRequest(request, "write", product.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Per-visitor spacing based on the last CUSTOMER message (lastSeenAt moves
  // on every poll, so it cannot rate-limit sends).
  if (visitor.conversationId) {
    const lastCustomerMessage = await prisma.message.findFirst({
      where: { conversationId: visitor.conversationId, kind: "CUSTOMER" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (lastCustomerMessage && Date.now() - lastCustomerMessage.createdAt.getTime() < MIN_SEND_INTERVAL_MS) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
  }

  const payload = (await request.json().catch(() => null)) as
    | { body?: string; pageUrl?: string; attachmentIds?: string[]; diagnostics?: unknown }
    | null;
  if (!payload?.body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const result = await visitorSendMessage({
    product,
    visitor,
    body: payload.body,
    pageUrl: payload.pageUrl ?? null,
    attachmentIds: payload.attachmentIds,
    // Optional browser-diagnostics snapshot (docs/design/diagnostics.md):
    // validated and bounded server-side; never rejects the message.
    diagnostics: payload.diagnostics,
    userAgent: request.headers.get("user-agent") ?? "",
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  const thread = await visitorListMessages({ product, visitor: { ...visitor, conversationId: result.conversationId } });
  return NextResponse.json({ thread, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) });
}

/** Poll the thread (cursor-free V1 polling; SSE arrives with ADR-0003). */
export async function GET(request: NextRequest) {
  const limited = preflightLimit(request);
  if (limited) return limited;
  const guarded = await guard(request);
  if ("error" in guarded) return guarded.error;
  const { product, visitor } = guarded;
  if (!rateLimitWidgetRequest(request, "read", product.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const thread = await visitorListMessages({ product, visitor });
  return NextResponse.json({ thread }, { headers: { "cache-control": "no-store" } });
}

/** Email capture (away form and live-chat capture card, FR-CHAT-04). */
export async function PUT(request: NextRequest) {
  if (!widgetRequestOriginOk(request.headers.get("origin"), serviceOriginFrom(request.headers, request.nextUrl.origin))) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  const limited = preflightLimit(request);
  if (limited) return limited;
  const guarded = await guard(request);
  if ("error" in guarded) return guarded.error;
  const { product, visitor } = guarded;
  if (!rateLimitWidgetRequest(request, "write", product.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const payload = (await request.json().catch(() => null)) as { email?: string } | null;
  if (!payload?.email) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const result = await setVisitorEmail({ visitor, email: payload.email });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await touchVisitor(visitor.visitorId);
  return NextResponse.json({ email: result.email });
}
