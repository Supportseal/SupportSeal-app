/**
 * Client IP for the per-IP rate limiters (widget, API-token failure, auth
 * sign-up). Issue #219: the first X-Forwarded-For entry is whatever the
 * caller sent, so keying on it let anyone lock out a victim's IP or dodge
 * the limit by rotating the value.
 *
 * - TRUSTED_PROXY_HEADER set: only that header is read and XFF is ignored.
 *   The operator asserts the origin accepts traffic from that proxy alone
 *   (firewall, authenticated origin pulls, Tunnel); see docs/self-hosting.md.
 *   A request missing the header shares the "unknown" bucket, so a
 *   misconfiguration limits more, never less.
 * - Unset: the LAST X-Forwarded-For entry, the address the nearest proxy
 *   observed and appended (nginx $proxy_add_x_forwarded_for) or wrote over
 *   the header with (Caddy and Traefik default). Entries to its left are
 *   client-controlled and ignored. Ignoring XFF outright would switch the
 *   limiters off behind every plain reverse proxy, the documented default.
 *   Next.js route handlers expose no socket address, so a deployment with
 *   no proxy has no identity to key on: null, and callers fail open
 *   rather than collapse every client into one bucket that a single caller
 *   could exhaust for all of them.
 */
export function clientIp(request: Pick<Request, "headers">): string | null {
  const trustedHeader = process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (trustedHeader) return request.headers.get(trustedHeader)?.trim() || "unknown";

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 1) warnOnce(MULTI_HOP_WARNING);
    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  warnOnce(NO_IP_WARNING);
  return null;
}

const NO_IP_WARNING =
  "[client-ip] No X-Forwarded-For or X-Real-IP header and TRUSTED_PROXY_HEADER is unset: " +
  "per-IP rate limits are skipped for these requests. Put the app behind a reverse proxy that " +
  "sets X-Forwarded-For, and set TRUSTED_PROXY_HEADER if it provides a dedicated client-IP header " +
  "(see docs/self-hosting.md).";

const MULTI_HOP_WARNING =
  "[client-ip] X-Forwarded-For carries several entries and TRUSTED_PROXY_HEADER is unset: " +
  "per-IP rate limits key on the last entry (the nearest proxy's view). If that is an outer " +
  "proxy such as Cloudflare rather than the visitor, set TRUSTED_PROXY_HEADER to its client-IP " +
  "header, but only when the origin accepts traffic from that proxy alone (see docs/self-hosting.md).";

const warned = new Set<string>();

function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}
