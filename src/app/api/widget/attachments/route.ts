import { NextResponse, type NextRequest } from "next/server";

import { AttachmentError, storeAttachment, validateAttachment } from "@/lib/attachments";
import {
  isWidgetOriginAllowed,
  loadWidgetProduct,
  resolveVisitorSession,
  serviceOriginFrom,
  sessionOriginMatches,
  widgetRequestOriginOk,
  visitorTokenFromRequest,
} from "@/lib/widget";
import { rateLimitWidgetRequest } from "@/lib/widget-rate-limit";

export const dynamic = "force-dynamic";

/** Visitor attachment upload (FR-FILE-01): multipart, session gated. */
export async function POST(request: NextRequest) {
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

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const validated = validateAttachment({
      name: file.name,
      type: file.type,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    const stored = await storeAttachment({
      workspaceId: product.workspaceId,
      productId: product.id,
      conversationId: visitor.conversationId,
      visitorId: visitor.visitorId,
      file: validated,
    });
    return NextResponse.json({ attachment: stored });
  } catch (error) {
    if (error instanceof AttachmentError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
