import { NextResponse, type NextRequest } from "next/server";

import { noteWidgetConfigRequest } from "@/lib/install-signals";
import { isServicePaused } from "@/lib/service-pause";
import { getAvailabilityForProduct, isWidgetOriginAllowed, loadWidgetProduct, serviceOriginFrom } from "@/lib/widget";

export const dynamic = "force-dynamic";

/**
 * Public widget configuration (FR-CHAT-01). CORS-open for the loader
 * (credentials are never needed here); the key identifies the Product and
 * grants no privileged access. Invalid key/origin returns an error with no
 * detail.
 */
export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key") ?? "";
  const hostParam = request.nextUrl.searchParams.get("host");
  const product = await loadWidgetProduct(key);
  if (!product) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const referer = request.headers.get("referer");
  const serviceOrigin = serviceOriginFrom(request.headers, request.nextUrl.origin);
  const serviceIsProduction = process.env.NODE_ENV === "production";
  const allowed = isWidgetOriginAllowed({
    productDomains: product.domains,
    hostParam,
    referer,
    serviceOrigin,
    serviceIsProduction,
    testToken: request.nextUrl.searchParams.get("testToken"),
    productId: product.id,
  });
  // Installation panel (issue #192). Only reached for a real, unarchived
  // key; synchronous and DB-free here, the write runs after the response.
  noteWidgetConfigRequest({
    productId: product.id,
    productDomains: product.domains,
    hostParam,
    referer,
    allowed,
    serviceHostname: URL.canParse(serviceOrigin) ? new URL(serviceOrigin).hostname : null,
    serviceIsProduction,
  });
  if (!allowed) {
    // Let the cross-origin loader read the rejection and explain it. This
    // exposes only the error, never the denied Product's configuration.
    return NextResponse.json({ error: "origin_not_allowed" }, {
      status: 403,
      headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
    });
  }

  const availability = await getAvailabilityForProduct(product.workspaceId);
  return NextResponse.json(
    {
      name: product.name,
      color: product.primaryColor,
      availability,
      // Absent means off: disabled Products run no capture code.
      ...(product.diagnosticsEnabledAt ? { diagnostics: true } : {}),
      // Free plan cutoff (src/lib/service-pause.ts); absent means taking chats.
      ...((await isServicePaused(product.workspaceId)) ? { paused: true } : {}),
    },
    {
      headers: {
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET",
    },
  });
}
