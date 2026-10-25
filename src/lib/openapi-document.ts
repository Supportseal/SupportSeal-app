import { createHash } from "node:crypto";

import spec from "../../docs/openapi.json";

/** The file's own default (the hosted tier); also the fallback when a request carries no usable origin. */
export const OPENAPI_DEFAULT_BASE_URL = spec.servers[0].variables.baseUrl.default;

/**
 * Normalised http(s) origin (lower-case scheme and host, default port dropped), or null.
 * The input must be exactly `scheme://authority`: a Host header carrying a path, query,
 * fragment, userinfo, backslash or whitespace is not trusted into the document.
 */
function usableOrigin(origin: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@\\]+$/iu.test(origin)) return null;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * docs/openapi.json (the file the drift test checks) with only
 * `servers[0].variables.baseUrl.default` pointed at the caller's own origin, so
 * the spec works unchanged on any installation. Imported, so it is bundled
 * into the standalone build.
 */
export function renderOpenApi(origin: string): { body: string; etag: string } {
  const baseUrl = usableOrigin(origin) ?? OPENAPI_DEFAULT_BASE_URL;
  const [server, ...otherServers] = spec.servers;
  const document = {
    ...spec,
    servers: [
      { ...server, variables: { ...server.variables, baseUrl: { ...server.variables.baseUrl, default: baseUrl } } },
      ...otherServers,
    ],
  };
  const body = JSON.stringify(document);
  return { body, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"` };
}

/** True when an `If-None-Match` header (RFC 9110 §13.1.2, weak comparison) already names `etag`. */
export function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((candidate) => candidate.trim().replace(/^W\//u, "") === etag);
}
