import { NextResponse, type NextRequest } from "next/server";

import { sanitizeContext, sanitizeIdentity, ContextValidationError } from "@/lib/dev-context";
import {
  isWidgetOriginAllowed,
  loadWidgetProduct,
  resolveVisitorSession,
  serviceOriginFrom,
  sessionOriginMatches,
  widgetRequestOriginOk,
  setVisitorIdentityAndContext,
  visitorTokenFromRequest,
} from "@/lib/widget";
import { rateLimitWidgetRequest } from "@/lib/widget-rate-limit";

export const dynamic = "force-dynamic";

/**
 * identify() / context() endpoint (FR-CTX-01/02). Session-cookie gated like
 * the other visitor endpoints; payloads are validated and bounded.
 */
export async function PUT(request: NextRequest) {
  if (!widgetRequestOriginOk(request.headers.get("origin"), serviceOriginFrom(request.headers, request.nextUrl.origin))) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }
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
  if (!rateLimitWidgetRequest(request, "write", product.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const token = visitorTokenFromRequest(request, product.id);
  const visitor = await resolveVisitorSession(product, token);
  if (!visitor) return NextResponse.json({ error: "no_session" }, { status: 401 });
  if (!sessionOriginMatches(visitor, hostParam)) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }

  const payload = (await request.json().catch(() => null)) as
    | { identify?: unknown; context?: unknown }
    | null;
  if (!payload) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const identity = payload.identify !== undefined ? sanitizeIdentity(payload.identify) : undefined;
    const context = payload.context !== undefined ? sanitizeContext(payload.context) : undefined;
    const result = await setVisitorIdentityAndContext({ visitor, identity, context });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ email: result.email });
  } catch (error) {
    if (error instanceof ContextValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
