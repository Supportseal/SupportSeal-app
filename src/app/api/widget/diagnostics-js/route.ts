import { NextResponse } from "next/server";

import { COLLECTOR_JS } from "@/lib/diagnostics/collector-source";
import { stripWidgetComments } from "@/lib/widget-bundle-strip";

export const dynamic = "force-dynamic";

/**
 * The optional diagnostics collector bundle
 * (docs/design/diagnostics.md "Architecture"): fetched by the widget loader
 * only when `/api/widget/config` says `diagnostics: true`, so disabled
 * Products run no capture code. Served as plain JS like the loader
 * (comment lines stripped, DX-17 budget).
 */
export async function GET() {
  return new NextResponse(stripWidgetComments(COLLECTOR_JS), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
