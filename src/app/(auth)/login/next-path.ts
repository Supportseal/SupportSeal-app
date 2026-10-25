/**
 * Only same-origin destinations for the post-sign-in redirect. Parse the
 * value and keep it only when its origin matches this origin: browsers
 * strip tab/CR/LF and normalize backslashes before parsing, so blocklists
 * on the raw string (//host, /\host, %09…) always have a bypass left.
 * The rebuilt destination must additionally be a plain site path: a
 * same-origin absolute URL with a double-slash pathname
 * (https://this-origin//evil.example) would otherwise hand
 * window.location.assign the scheme-relative //evil.example. Anything
 * else — cross-origin, scheme-relative, malformed — falls back to
 * /inbox. Shared by the client form (post-sign-in navigation) and the
 * server page (redirect when already authenticated).
 */
export function safeNextPath(raw: string | null | undefined, origin: string): string {
  if (raw) {
    try {
      const url = new URL(raw, origin);
      const destination = url.pathname + url.search + url.hash;
      if (url.origin === origin && destination.startsWith("/") && !destination.startsWith("//")) {
        return destination;
      }
    } catch {
      // Unparsable destination: fall through to the default.
    }
  }
  return "/inbox";
}
