import { matchesEtag, OPENAPI_DEFAULT_BASE_URL, renderOpenApi } from "@/lib/openapi-document";
import { serviceOriginFrom } from "@/lib/widget";

export const dynamic = "force-dynamic";

/**
 * The OpenAPI spec of the token-authenticated Workspace API, served live so an
 * outside coding agent needs only a base URL and a token. Public: no auth, no
 * database, no cookies. The body is docs/openapi.json with its server default
 * set to the request's own origin (forwarded host, as the widget routes do;
 * never NEXT_PUBLIC_APP_URL), so it varies by headers a client can set.
 * Hence `private`: a shared cache that ignores Vary (a CDN keyed on URL alone)
 * must never store a body built from a spoofed X-Forwarded-Host, since agents
 * send their bearer token to that default server. Browsers still cache it, and
 * the ETag keeps revalidation cheap.
 */
export function GET(request: Request) {
  const { body, etag } = renderOpenApi(serviceOriginFrom(request.headers, OPENAPI_DEFAULT_BASE_URL));
  const headers = {
    "cache-control": "private, max-age=3600",
    "access-control-allow-origin": "*",
    etag,
    vary: "Host, X-Forwarded-Host, X-Forwarded-Proto",
  };
  if (matchesEtag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
}
