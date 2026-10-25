import type { NextRequest } from "next/server";

import { clientIp } from "@/lib/client-ip";

/**
 * In-process rate limiter for the public auth endpoints (issue #184).
 * Same convention as widget-rate-limit.ts: fixed window, bounded map with
 * periodic pruning, and per-process limits — acceptable for V1
 * self-hosted deployments.
 *
 * The self-hosted sign-up gate answers unauthenticated POSTs to
 * /api/auth/sign-up/email before a session exists, so no identity can be
 * trusted: buckets key on the client IP alone and are charged before any
 * database access, keeping invite-token probes throttled even when every
 * request carries a different candidate email or token.
 */
export const AUTH_RATE_LIMITS = {
  windowMs: 60_000,
  /** POST /api/auth/sign-up/email per client IP (issue #184). */
  signUp: 10,
} as const;

const hits = new Map<string, number[]>();
const PRUNE_AT = 10_000;
/** Keys visited per request once the map is large. A full scan stays off the request path. */
const PRUNE_BATCH = 32;
let pruneIterator: Iterator<string> | null = null;

/**
 * Charges the sign-up bucket for the client IP. Returns false when over
 * budget; rejected requests add no hit, so they cannot extend the
 * saturation.
 */
export function rateLimitAuthSignUp(request: NextRequest): boolean {
  const now = Date.now();
  pruneIfLarge(now);
  const ip = clientIp(request);
  if (ip === null) return true;
  const key = `sign-up|ip:${ip}`;
  const own = windowHits(key, now);
  const rejected = own.length >= AUTH_RATE_LIMITS.signUp;
  if (!rejected) own.push(now);
  hits.set(key, own);
  return !rejected;
}

function windowHits(key: string, now: number): number[] {
  return (hits.get(key) ?? []).filter((t) => now - t < AUTH_RATE_LIMITS.windowMs);
}

function pruneIfLarge(now: number) {
  if (hits.size <= PRUNE_AT) {
    pruneIterator = null;
    return;
  }
  // Timestamps are append-only, so the last one is the newest: that matches
  // deleting a key only when every timestamp is outside the window (same
  // argument as widget-rate-limit.ts).
  const iter = pruneIterator ?? hits.keys();
  const windowMs = AUTH_RATE_LIMITS.windowMs;
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
