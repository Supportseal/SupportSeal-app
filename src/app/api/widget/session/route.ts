import { NextResponse, type NextRequest } from "next/server";

import { VISITOR_COOKIE_MAX_AGE_SECONDS } from "@/config/session-lifetimes";
import { rateLimitWidgetSessionMint, rateLimitWidgetRequest } from "@/lib/widget-rate-limit";

import {
  createVisitorSession,
  getAvailabilityForProduct,
  isWidgetOriginAllowed,
  serviceOriginFrom,
  loadWidgetProduct,
  resolveBootSession,
  revokeVisitorSession,
  widgetRequestOriginOk,
  visitorCookieName,
  visitorTokenFromRequest,
  visitorListMessages,
  type WidgetProduct,
} from "@/lib/widget";

export const dynamic = "force-dynamic";

/** Product lookup plus the embedding-origin allowlist shared by POST and DELETE. */
async function loadAllowedProduct(
  request: NextRequest,
): Promise<{ product: WidgetProduct; hostParam: string | null } | NextResponse> {
  const key = request.nextUrl.searchParams.get("key") ?? "";
  const hostParam = request.nextUrl.searchParams.get("host");
  const product = await loadWidgetProduct(key);
  if (!product) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const allowed = isWidgetOriginAllowed({
    productDomains: product.domains,
    hostParam,
    referer: request.headers.get("referer"),
    serviceOrigin: serviceOriginFrom(request.headers, request.nextUrl.origin),
    serviceIsProduction: process.env.NODE_ENV === "production",
    testToken: request.nextUrl.searchParams.get("testToken"),
    productId: product.id,
  });
  if (!allowed) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  return { product, hostParam };
}

export async function POST(request: NextRequest) {
  const loaded = await loadAllowedProduct(request);
  if (loaded instanceof NextResponse) return loaded;
  const { product, hostParam } = loaded;
  if (!rateLimitWidgetRequest(request, "session", product.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const existingToken = visitorTokenFromRequest(request, product.id);
  // A credential resumes the previous session only when it was issued for
  // this exact origin (scheme + host + port, issue #61). Anything else — a
  // different port of the same host, another domain, a scheme change, a
  // pre-binding row, no credential at all — falls through to a fresh
  // anonymous visitor and a new cookie instead of erroring.
  const existing = await resolveBootSession(product, existingToken, hostParam);
  if (existing) {
    const thread = await visitorListMessages({ product, visitor: existing });
    const availability = await getAvailabilityForProduct(product.workspaceId);
    return NextResponse.json({
      name: product.name,
      color: product.primaryColor,
      ...(product.supportEmail ? { supportEmail: product.supportEmail } : {}),
      session: { email: existing.email, name: existing.name },
      availability,
      ...(product.diagnosticsEnabledAt ? { diagnostics: true } : {}),
      thread,
    });
  }

  // Mint cap (issue #81): the per-IP mint bucket is charged only now that
  // resume has failed and a new ChatVisitor row is actually about to be
  // created — the resumed branch above is never counted. Unknown tokens
  // still fall through to here (a stale credential must degrade to a fresh
  // session, #61, never error); the panel's boot retry already treats the
  // 429 as backoff-and-retry.
  if (!rateLimitWidgetSessionMint(request)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const { token } = await createVisitorSession(product, hostParam);
  const availability = await getAvailabilityForProduct(product.workspaceId);
  const response = NextResponse.json({
    name: product.name,
    color: product.primaryColor,
    ...(product.supportEmail ? { supportEmail: product.supportEmail } : {}),
    // The token is echoed once so the panel can persist it in its
    // partitioned sessionStorage — the fallback when third-party cookies
    // (the primary transport) are blocked, e.g. Safari ITP.
    token,
    session: { email: null, name: null },
    availability,
    ...(product.diagnosticsEnabledAt ? { diagnostics: true } : {}),
    thread: { conversationId: null, ticketRef: null, messages: [], status: "OPEN" },
  });
  response.cookies.set(
    visitorCookieName(product.id),
    token,
    visitorCookieOptions(VISITOR_COOKIE_MAX_AGE_SECONDS),
  );
  return response;
}

/**
 * Host sign-out (issue #151): `SupportSealWidget.reset()` makes the panel
 * call this before booting a fresh session. The token is revoked server-side
 * and the cookie expired, so the previous user's thread and identity cannot
 * resume on a shared device. Idempotent: no session / unknown token is 204.
 */
export async function DELETE(request: NextRequest) {
  if (!widgetRequestOriginOk(request.headers.get("origin"), serviceOriginFrom(request.headers, request.nextUrl.origin))) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  const loaded = await loadAllowedProduct(request);
  if (loaded instanceof NextResponse) return loaded;
  const { product } = loaded;
  if (!rateLimitWidgetRequest(request, "revoke", product.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Revoke every credential the request carries: a stale cookie must not
  // shield a distinct sessionStorage token (or the reverse) from the reset.
  // visitorTokenFromRequest prefers the cookie, then this header, then t=.
  const presented = visitorTokenFromRequest(request, product.id);
  const stored = request.headers.get("x-ss-visitor-token")?.trim();
  await revokeVisitorSession(product, presented);
  if (stored && stored !== presented) await revokeVisitorSession(product, stored);

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(visitorCookieName(product.id), "", visitorCookieOptions(0));
  return response;
}

// The panel iframe is served by SupportSeal but embedded in the customer's
// site, so its requests are third-party for the browser: the cookie must be
// None+Secure (Partitioned for CHIPS). CSRF is covered by the Origin-header
// check in widgetRequestOriginOk plus the per-session origin binding — not
// by SameSite. Clearing must repeat the same attributes to hit the same
// (partitioned) cookie.
function visitorCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    partitioned: true,
    path: "/",
    maxAge,
  } as const;
}

