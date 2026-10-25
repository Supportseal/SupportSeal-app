import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { AUTH_RATE_LIMITS } from "@/lib/auth-rate-limit";

/**
 * Issue #184: per-IP limiter in front of the self-hosted sign-up gate.
 * Buckets key on the client IP alone (no identity exists to trust),
 * rejected requests never extend the saturation, and the client-IP
 * semantics mirror widget-rate-limit.ts.
 */

type Limiter = typeof import("@/lib/auth-rate-limit");

let limiter: Limiter;

beforeEach(async () => {
  vi.resetModules();
  limiter = await import("@/lib/auth-rate-limit");
});

afterEach(() => {
  vi.useRealTimers();
});

function request(opts: { ip?: string; headers?: Record<string, string> }) {
  const headers = new Headers();
  if (opts.ip) headers.set("x-forwarded-for", opts.ip);
  for (const [key, value] of Object.entries(opts.headers ?? {})) headers.set(key, value);
  return new NextRequest(new URL("http://localhost:3000/api/auth/sign-up/email"), {
    method: "POST",
    headers,
  });
}

describe("auth sign-up rate limiter (issue #184)", () => {
  it("caps sign-up POSTs per client IP", () => {
    let admitted = 0;
    for (let i = 0; i < AUTH_RATE_LIMITS.signUp + 20; i++) {
      if (limiter.rateLimitAuthSignUp(request({ ip: "9.9.9.9" }))) admitted += 1;
    }
    expect(admitted).toBe(AUTH_RATE_LIMITS.signUp);
  });

  it("keeps client IPs in separate buckets", () => {
    for (let i = 0; i < AUTH_RATE_LIMITS.signUp; i++) {
      expect(limiter.rateLimitAuthSignUp(request({ ip: "8.8.8.8" }))).toBe(true);
    }
    expect(limiter.rateLimitAuthSignUp(request({ ip: "8.8.8.8" }))).toBe(false);
    expect(limiter.rateLimitAuthSignUp(request({ ip: "8.8.8.7" }))).toBe(true);
  });

  it("rejected requests do not extend the saturation", () => {
    vi.useFakeTimers();
    const ip = "7.7.7.7";
    for (let i = 0; i < AUTH_RATE_LIMITS.signUp; i++) {
      expect(limiter.rateLimitAuthSignUp(request({ ip }))).toBe(true);
    }
    for (let i = 0; i < 100; i++) {
      expect(limiter.rateLimitAuthSignUp(request({ ip }))).toBe(false);
    }
    vi.advanceTimersByTime(AUTH_RATE_LIMITS.windowMs + 1);
    expect(limiter.rateLimitAuthSignUp(request({ ip }))).toBe(true);
  });

  it("reads only the configured trusted proxy header when set", () => {
    process.env.TRUSTED_PROXY_HEADER = "cf-connecting-ip";
    try {
      for (let i = 0; i < AUTH_RATE_LIMITS.signUp; i++) {
        expect(
          limiter.rateLimitAuthSignUp(request({ headers: { "cf-connecting-ip": "6.6.6.6" } })),
        ).toBe(true);
      }
      // Same real client claiming a fresh XFF stays in the burned bucket.
      expect(
        limiter.rateLimitAuthSignUp(
          request({ ip: "1.2.3.4", headers: { "cf-connecting-ip": "6.6.6.6" } }),
        ),
      ).toBe(false);
      // A different real client is still admitted.
      expect(
        limiter.rateLimitAuthSignUp(
          request({ ip: "6.6.6.6", headers: { "cf-connecting-ip": "5.5.5.5" } }),
        ),
      ).toBe(true);
    } finally {
      delete process.env.TRUSTED_PROXY_HEADER;
    }
  });

  it("ignores forged x-forwarded-for prefixes and fails open without an IP (issue #219)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = process.env.TRUSTED_PROXY_HEADER;
    delete process.env.TRUSTED_PROXY_HEADER;
    try {
      for (let i = 0; i < AUTH_RATE_LIMITS.signUp; i++) {
        expect(limiter.rateLimitAuthSignUp(request({ ip: `forged-${i}, 8.8.8.8` }))).toBe(true);
      }
      expect(limiter.rateLimitAuthSignUp(request({ ip: "forged-x, 8.8.8.8" }))).toBe(false);
      for (let i = 0; i < AUTH_RATE_LIMITS.signUp * 2; i++) {
        expect(limiter.rateLimitAuthSignUp(request({}))).toBe(true);
      }
    } finally {
      warn.mockRestore();
      if (original !== undefined) process.env.TRUSTED_PROXY_HEADER = original;
    }
  });
});
