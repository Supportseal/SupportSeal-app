import type { NextRequest } from "next/server";

import { clientIp } from "@/lib/client-ip";
import { visitorTokenFromRequest } from "@/lib/widget";

/**
 * In-process rate limiter for the public widget endpoints (abuse control;
 * the origin gate is a UX check, not a boundary — CodeRabbit finding,
 * widget.ts). Bounded map with periodic pruning; multi-process deployments
 * get per-process limits, which is acceptable for V1.
 *
 * Issue #57: one failing visitor used to starve the single shared per-IP
 * bucket (60/60s) for everyone behind that IP. Buckets are now:
 *  - classed per endpoint group (session / read / write), so retries on one
 *    endpoint cannot consume another endpoint's budget;
 *  - keyed by the visitor token the server would authenticate for the
 *    request (widget.ts visitorTokenFromRequest precedence: the product
 *    ss_visitor_<productId> cookie, then the x-ss-visitor-token header,
 *    or the t= query), falling back to the client IP;
 *  - still capped overall by a per-IP umbrella, so minting fresh tokens is
 *    not a bypass. Read-only endpoints (SSE reconnects, polling) get a
 *    higher budget than state-changing ones.
 */
export const WIDGET_RATE_LIMITS = {
  windowMs: 60_000,
  /** POST /api/widget/session per identity. */
  session: 60,
  /** Read-only stream reconnects and message polls per identity. */
  read: 240,
  /** State-changing sends, context and attachment uploads per identity. */
  write: 60,
  /**
   * Visitor-session revocation (reset() on host sign-out). Its own allowance
   * so a visitor who exhausted `write` cannot block their own logout.
   */
  revoke: 30,
  /** All widget endpoints combined per client IP (token-minting guard). */
  ipUmbrella: 300,
  /**
   * New ChatVisitor rows (session mints) per client IP, charged only when
   * the route is about to create one (issue #81).
   */
  sessionMint: 30,
  /**
   * Keyed form submissions (issue #154) per client IP. Each accepted post
   * creates a Conversation, so the budget matches sessionMint rather than
   * the write bucket.
   */
  formSubmission: 30,
  /**
   * Failed API-token authentications (issue #187) per client IP. Requests
   * from an IP at the cap are refused before any database lookup.
   */
  apiTokenFailure: 20,
  /**
   * Write requests (POST/PATCH) per API token (issue #187). Each creates or
   * rewrites rows, so a leaked token cannot churn Products unthrottled.
   */
  apiTokenWrite: 30,
  /** Read requests per API token (`/api/v1`, AA11). */
  apiTokenRead: 120,
  /** Agent replies per API token: each one emails or chats a customer (AA11). */
  apiTokenReply: 20,
  /** Token creation and revocation per API token (AA11). */
  apiTokenAdmin: 10,
  /** All `/api/v1` requests per client IP, across tokens, charged before authentication (AA11). */
  apiIp: 300,
} as const;

export type ApiTokenBucket = keyof Pick<
  typeof WIDGET_RATE_LIMITS,
  "apiTokenRead" | "apiTokenWrite" | "apiTokenReply" | "apiTokenAdmin"
>;

export type WidgetRateBucket = keyof Pick<typeof WIDGET_RATE_LIMITS, "session" | "read" | "write" | "revoke">;

const hits = new Map<string, number[]>();
const PRUNE_AT = 10_000;
/** Keys visited per request once the map is large. A full scan stays off the request path. */
const PRUNE_BATCH = 32;
let pruneIterator: Iterator<string> | null = null;

export function rateLimitWidgetRequest(
  request: NextRequest,
  bucket: WidgetRateBucket,
  productId?: string,
): boolean {
  const now = Date.now();
  pruneIfLarge(now);
  const ip = clientIp(request);
  const identity = visitorIdentityToken(request, productId) ?? (ip === null ? undefined : `ip:${ip}`);
  // No visitor token and no determinable IP (no proxy headers, issue #219): nothing to key on.
  if (identity === undefined) return true;
  const own = windowHits(`${bucket}|${identity}`, now);
  const umbrella = ip === null ? [] : windowHits(`ip|${ip}`, now);
  const rejected =
    umbrella.length >= WIDGET_RATE_LIMITS.ipUmbrella || own.length >= WIDGET_RATE_LIMITS[bucket];
  // Rejected requests add no hit: they must not extend the saturation.
  if (!rejected) {
    umbrella.push(now);
    own.push(now);
  }
  if (ip !== null) hits.set(`ip|${ip}`, umbrella);
  hits.set(`${bucket}|${identity}`, own);
  return !rejected;
}

function windowHits(key: string, now: number): number[] {
  return (hits.get(key) ?? []).filter((t) => now - t < WIDGET_RATE_LIMITS.windowMs);
}

/**
 * Shared body for the IP-only buckets (session mints, form submissions,
 * preflight): one fixed window per client IP, rejected requests add no hit,
 * and a request with no determinable IP (issue #219) is allowed rather than
 * collapsed into one shared bucket a single caller could exhaust.
 */
function chargeIpBucket(request: Pick<Request, "headers">, keyPrefix: string, limit: number): boolean {
  const ip = clientIp(request);
  if (ip === null) return true;
  const now = Date.now();
  pruneIfLarge(now);
  const key = `${keyPrefix}${ip}`;
  const own = windowHits(key, now);
  const rejected = own.length >= limit;
  // Rejected requests add no hit: they must not extend the saturation.
  if (!rejected) own.push(now);
  hits.set(key, own);
  return !rejected;
}

/**
 * Session-mint limiter (issue #81). The `session` bucket keys on a claimed
 * token that is only verified against the database after the rate check, so
 * a caller sending a fresh made-up x-ss-visitor-token (or t=) per request
 * got a fresh bucket every time; the only remaining cap was the per-IP
 * umbrella, allowing thousands of ChatVisitor rows per hour from one IP.
 * This bucket keys on the client IP alone — no per-product key, no identity
 * — and is charged only when a mint is actually about to happen: the
 * session route calls it once resolveBootSession() has failed, so resume
 * traffic is never counted. Unknown tokens still reach it (they degrade to
 * a fresh session, #61) and are never rejected outright; over-cap mints get
 * the same 429 the boot client already treats as backoff-and-retry.
 */
export function rateLimitWidgetSessionMint(request: NextRequest): boolean {
  return chargeIpBucket(request, "session-mint|ip:", WIDGET_RATE_LIMITS.sessionMint);
}

/**
 * Keyed form-submission limiter (issue #154). IP-only like the mint bucket:
 * the form key identifies the Product, not a client — many sites and
 * visitors share one key, so a key-keyed bucket would let one site exhaust
 * everyone's budget while an attacker rotating forged keys would get a
 * fresh bucket per request. The route charges it before any database
 * access, so invalid-key probes cannot hammer the product lookup
 * unthrottled (#82 pattern).
 */
export function rateLimitFormSubmission(request: NextRequest): boolean {
  return chargeIpBucket(request, "form-submission|ip:", WIDGET_RATE_LIMITS.formSubmission);
}

/**
 * IP-only preflight bucket (issue #82). Routes whose guard must load the
 * product and session rows before it can authenticate a visitor call this
 * first, so unauthenticated 401/404 traffic cannot hammer the database
 * unthrottled. Keyed on the client IP alone — no token identity, because
 * at this point none can be trusted: the product-scoped cookie name needs
 * the product row, and header/t= values are attacker-chosen. Its budget
 * equals the per-IP umbrella but it is a separate key charged alongside
 * rateLimitWidgetRequest, whose token-keyed buckets still run after the
 * guard with their cookie-first identity (#57/#67): authenticated traffic
 * gains no new constraint, and rotating token transports buys nothing.
 */
export function rateLimitWidgetPreflight(request: NextRequest): boolean {
  return chargeIpBucket(request, "preflight-ip|", WIDGET_RATE_LIMITS.ipUmbrella);
}

/**
 * API-token brute-force guard (issue #187). `apiTokenAuthBlocked` is checked
 * before the token lookup; `recordApiTokenAuthFailure` charges one failure
 * (malformed, unknown, revoked or expired alike). Successful calls cost
 * nothing, so a script with a good token is never throttled by this bucket;
 * it only locks out an IP that keeps presenting bad ones. A request whose
 * client IP cannot be determined (issue #219) is neither blocked nor counted.
 */
export function apiTokenAuthBlocked(request: Pick<Request, "headers">): boolean {
  const ip = clientIp(request);
  if (ip === null) return false;
  return (
    windowHits(`api-token-failure|ip:${ip}`, Date.now()).length >= WIDGET_RATE_LIMITS.apiTokenFailure
  );
}

export function recordApiTokenAuthFailure(request: Pick<Request, "headers">): void {
  const ip = clientIp(request);
  if (ip === null) return;
  const now = Date.now();
  pruneIfLarge(now);
  const key = `api-token-failure|ip:${ip}`;
  const own = windowHits(key, now);
  own.push(now);
  hits.set(key, own);
}

/** Per-token budget for one request class; charged only after the token authenticated. */
export function rateLimitApiToken(bucket: ApiTokenBucket, tokenId: string): boolean {
  const now = Date.now();
  pruneIfLarge(now);
  const key = `${bucket}|${tokenId}`;
  const own = windowHits(key, now);
  const rejected = own.length >= WIDGET_RATE_LIMITS[bucket];
  // Rejected requests add no hit: they must not extend the saturation.
  if (!rejected) own.push(now);
  hits.set(key, own);
  return !rejected;
}

/** Per-IP umbrella for `/api/v1`, charged before the token lookup so floods never reach the database. */
export function rateLimitApiIp(request: Pick<Request, "headers">): boolean {
  return chargeIpBucket(request, "api-ip|", WIDGET_RATE_LIMITS.apiIp);
}

function pruneIfLarge(now: number) {
  if (hits.size <= PRUNE_AT) {
    pruneIterator = null;
    return;
  }
  // Timestamps are append-only, so the last one is the newest: that matches
  // deleting a key only when every timestamp is outside the window. Admission
  // already ignores stale timestamps in windowHits, so a key that waits for
  // a later batch cannot change allow or deny.
  const iter = pruneIterator ?? hits.keys();
  const windowMs = WIDGET_RATE_LIMITS.windowMs;
  let scanned = 0;
  let step = iter.next();
  while (!step.done && scanned < PRUNE_BATCH) {
    const times = hits.get(step.value);
    if (times) {
      const newest = times[times.length - 1];
      if (newest === undefined || now - newest >= windowMs) hits.delete(step.value);
    }
    scanned += 1;
    step = iter.next();
  }
  pruneIterator = step.done ? null : iter;
}

/**
 * Visitor tokens identify one browser session per Product across requests;
 * the product-scoped ss_visitor_<productId> cookie carries the same token
 * as the x-ss-visitor-token header (widget.ts visitorTokenFromRequest), so
 * all transports key the same bucket. The identity MUST be the token the
 * server authenticates — the exact visitorTokenFromRequest precedence,
 * cookie first — so a client whose cookie is the authenticated transport
 * cannot rotate header or t= values to mint fresh buckets (PR #67 review).
 * Any absent token falls back to the client IP; an empty transport value
 * counts as absent too (issue #82), so a blank cookie can neither shadow
 * the header/t= fallbacks nor key one shared "" bucket across clients.
 * Without a product scope no product cookie can be resolved; the
 * header/query transports then key the bucket directly.
 */
function visitorIdentityToken(request: NextRequest, productId?: string): string | undefined {
  if (productId) {
    return visitorTokenFromRequest(request, productId);
  }
  return (
    request.headers.get("x-ss-visitor-token")?.trim() ||
    request.nextUrl.searchParams.get("t")?.trim() ||
    undefined
  );
}
