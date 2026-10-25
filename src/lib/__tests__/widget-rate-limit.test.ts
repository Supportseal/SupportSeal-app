import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { WIDGET_RATE_LIMITS, type WidgetRateBucket } from "@/lib/widget-rate-limit";

/**
 * Issue #57: one failing visitor must not starve the whole IP bucket.
 * Endpoint classes get separate, token-keyed buckets under a per-IP
 * umbrella; rejected requests never extend the saturation.
 *
 * Issue #81 adds the per-IP session-mint cap (the token-keyed session
 * bucket counts a claimed token, which a minting caller rotates freely)
 * and the optional trusted client-IP header.
 *
 * Issue #82 adds the IP-only preflight bucket (caps the messages route's
 * pre-guard database lookups) and treats empty token transports as absent.
 */

type Limiter = typeof import("@/lib/widget-rate-limit");

let limiter: Limiter;

beforeEach(async () => {
  vi.resetModules();
  limiter = await import("@/lib/widget-rate-limit");
});

afterEach(() => {
  vi.useRealTimers();
});

function request(opts: {
  path: string;
  method?: string;
  ip?: string;
  tokenHeader?: string;
  cookie?: string;
}) {
  const url = new URL(`http://localhost:3000${opts.path}`);
  const headers = new Headers();
  if (opts.ip) headers.set("x-forwarded-for", opts.ip);
  if (opts.tokenHeader) headers.set("x-ss-visitor-token", opts.tokenHeader);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(url, { method: opts.method ?? "GET", headers });
}

function hitsUntilRejected(
  make: () => NextRequest,
  bucket: WidgetRateBucket,
  productId?: string,
  hardStop = WIDGET_RATE_LIMITS.ipUmbrella + 10,
): number {
  let admitted = 0;
  while (admitted < hardStop && limiter.rateLimitWidgetRequest(make(), bucket, productId)) admitted += 1;
  return admitted;
}

describe("widget rate limiter (issue #57)", () => {
  it("gives each endpoint class its own budget", () => {
    expect(hitsUntilRejected(() => request({ path: "/api/widget/session", method: "POST", ip: "9.9.9.9" }), "session")).toBe(
      WIDGET_RATE_LIMITS.session,
    );
    expect(limiter.rateLimitWidgetRequest(request({ path: "/api/widget/stream", ip: "9.9.9.9" }), "read")).toBe(true);
    expect(limiter.rateLimitWidgetRequest(request({ path: "/api/widget/messages", method: "POST", ip: "9.9.9.9" }), "write")).toBe(true);
  });

  it("read-only reconnects get a higher budget than writes", () => {
    expect(WIDGET_RATE_LIMITS.read).toBeGreaterThan(WIDGET_RATE_LIMITS.write);
    expect(
      hitsUntilRejected(() => request({ path: "/api/widget/stream", ip: "8.8.8.8", tokenHeader: "tok-read" }), "read"),
    ).toBe(WIDGET_RATE_LIMITS.read);
  });

  it("keys buckets by visitor token so one failing visitor cannot starve its IP", () => {
    expect(
      hitsUntilRejected(() => request({ path: "/api/widget/session", method: "POST", ip: "7.7.7.7", tokenHeader: "token-a" }), "session"),
    ).toBe(WIDGET_RATE_LIMITS.session);
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/session", method: "POST", ip: "7.7.7.7", tokenHeader: "token-b" }),
        "session",
      ),
    ).toBe(true);
  });

  it("recognises the token from the header, t= query and product-scoped cookie", () => {
    const ip = "6.6.6.6";
    // Each transport gets its own fresh token: all must reach the full budget.
    const make = (variant: "header" | "query" | "cookie") =>
      variant === "header"
        ? request({ path: "/api/widget/session", method: "POST", ip, tokenHeader: `tok-${variant}` })
        : variant === "query"
          ? request({ path: `/api/widget/session?t=tok-${variant}`, method: "POST", ip })
          : request({
              path: "/api/widget/session",
              method: "POST",
              ip,
              cookie: `other=1; ss_visitor_prod1=tok-${variant}`,
            });
    for (const variant of ["header", "query", "cookie"] as const) {
      expect(hitsUntilRejected(() => make(variant), "session", "prod1")).toBe(WIDGET_RATE_LIMITS.session);
    }
    // The same token via another transport still shares the burned bucket.
    expect(
      limiter.rateLimitWidgetRequest(request({ path: "/api/widget/session?t=tok-header", method: "POST", ip }), "session"),
    ).toBe(false);
    // Another Product's cookie must not be picked up (exact product match).
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/session", method: "POST", ip, cookie: "ss_visitor_other=tok-x" }),
        "session",
        "prod1",
      ),
    ).toBe(true);
  });

  it("keys buckets by the authenticated cookie, so rotated headers cannot mint fresh ones", () => {
    const ip = "2.2.2.2";
    const cookie = "ss_visitor_prod1=tok-cookie";
    // Burn the session bucket under the cookie's (authenticated) identity.
    expect(
      hitsUntilRejected(() => request({ path: "/api/widget/session", method: "POST", ip, cookie }), "session", "prod1"),
    ).toBe(WIDGET_RATE_LIMITS.session);
    // A client holding that valid cookie rotating header or t= values must
    // stay in the same bucket (PR #67 review: identity follows
    // visitorTokenFromRequest, cookie first) — no fresh buckets to abuse.
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/session", method: "POST", ip, cookie, tokenHeader: "rotated-1" }),
        "session",
        "prod1",
      ),
    ).toBe(false);
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/session?t=rotated-2", method: "POST", ip, cookie }),
        "session",
        "prod1",
      ),
    ).toBe(false);
  });

  it("falls back to the client IP when no token is presented", () => {
    expect(
      hitsUntilRejected(() => request({ path: "/api/widget/messages", method: "POST", ip: "5.5.5.5" }), "write"),
    ).toBe(WIDGET_RATE_LIMITS.write);
    // A presented token escapes the burned IP-fallback bucket.
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/messages", method: "POST", ip: "5.5.5.5", tokenHeader: "tok-c" }),
        "write",
      ),
    ).toBe(true);
  });

  it("caps token minting with a per-IP umbrella", () => {
    let admitted = 0;
    for (let i = 0; i < WIDGET_RATE_LIMITS.ipUmbrella + 50; i++) {
      // Fresh token each hit: every per-identity bucket stays empty.
      if (
        limiter.rateLimitWidgetRequest(
          request({ path: "/api/widget/messages", method: "POST", ip: "4.4.4.4", tokenHeader: `tok-${i}` }),
          "write",
        )
      ) {
        admitted += 1;
      }
    }
    expect(admitted).toBe(WIDGET_RATE_LIMITS.ipUmbrella);
  });

  it("rejected requests do not extend the saturation", () => {
    vi.useFakeTimers();
    const ip = "3.3.3.3";
    expect(hitsUntilRejected(() => request({ path: "/api/widget/session", method: "POST", ip }), "session")).toBe(
      WIDGET_RATE_LIMITS.session,
    );
    for (let i = 0; i < 100; i++) {
      expect(limiter.rateLimitWidgetRequest(request({ path: "/api/widget/session", method: "POST", ip }), "session")).toBe(false);
    }
    vi.advanceTimersByTime(WIDGET_RATE_LIMITS.windowMs + 1);
    expect(limiter.rateLimitWidgetRequest(request({ path: "/api/widget/session", method: "POST", ip }), "session")).toBe(true);
  });

  it("keeps admitting correctly while the map is pruned past its bound", () => {
    vi.useFakeTimers();
    // Many distinct identities (e.g. a botnet of single-hit IPs) grow the
    // map past the prune threshold; pruning must not break admission.
    for (let i = 0; i < 10_050; i++) {
      expect(
        limiter.rateLimitWidgetRequest(
          request({ path: "/api/widget/messages", method: "POST", ip: `10.${i}.0.1` }),
          "write",
        ),
      ).toBe(true);
    }
    vi.advanceTimersByTime(WIDGET_RATE_LIMITS.windowMs + 1);
    // A fresh identity and an aged one both admit after pruning began.
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/messages", method: "POST", ip: "10.9.9.9", tokenHeader: "fresh" }),
        "write",
      ),
    ).toBe(true);
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/messages", method: "POST", ip: "10.0.0.1" }),
        "write",
      ),
    ).toBe(true);
  });
});

describe("empty credentials are absent (issue #82)", () => {
  it("an empty product cookie does not shadow the header transport nor share one bucket", () => {
    const ip = "1.2.3.4";
    const cookie = "ss_visitor_prod1=";
    // A present-but-blank cookie must be treated as absent: the header
    // token keys the bucket, not the empty value.
    expect(
      hitsUntilRejected(() => request({ path: "/api/widget/session", method: "POST", ip, cookie, tokenHeader: "tok-a" }), "session", "prod1"),
    ).toBe(WIDGET_RATE_LIMITS.session);
    // Pre-fix every empty-cookie client shared one `session|` bucket, so a
    // different header token was already starved; post-fix it is a fresh
    // identity and still admitted.
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/session", method: "POST", ip, cookie, tokenHeader: "tok-b" }),
        "session",
        "prod1",
      ),
    ).toBe(true);
  });

  it("clients with only an empty cookie fall back to their own IP bucket", () => {
    expect(
      hitsUntilRejected(
        () => request({ path: "/api/widget/session", method: "POST", ip: "1.2.3.5", cookie: "ss_visitor_prod1=; other=1" }),
        "session",
        "prod1",
      ),
    ).toBe(WIDGET_RATE_LIMITS.session);
    // A different IP with the same blank cookie gets its own budget instead
    // of joining the burned shared "" bucket.
    expect(
      limiter.rateLimitWidgetRequest(
        request({ path: "/api/widget/session", method: "POST", ip: "1.2.3.6", cookie: "ss_visitor_prod1=" }),
        "session",
        "prod1",
      ),
    ).toBe(true);
  });
});

describe("IP-only preflight (issue #82)", () => {
  it("caps pre-guard lookups per IP at the umbrella budget, ignoring claimed tokens", () => {
    let admitted = 0;
    for (let i = 0; i < WIDGET_RATE_LIMITS.ipUmbrella + 20; i++) {
      // A fresh claimed token per request must not matter: before the
      // product row is loaded no token identity can be trusted, so the
      // preflight keys on the IP alone.
      if (
        limiter.rateLimitWidgetPreflight(
          request({ path: "/api/widget/messages", method: "POST", ip: "1.1.1.1", tokenHeader: `fresh-${i}` }),
        )
      ) {
        admitted += 1;
      }
    }
    expect(admitted).toBe(WIDGET_RATE_LIMITS.ipUmbrella);
  });

  it("keeps IPs separate and rejected requests do not extend the saturation", () => {
    vi.useFakeTimers();
    for (let i = 0; i < WIDGET_RATE_LIMITS.ipUmbrella; i++) {
      expect(
        limiter.rateLimitWidgetPreflight(request({ path: "/api/widget/messages", method: "POST", ip: "1.1.1.2" })),
      ).toBe(true);
    }
    expect(
      limiter.rateLimitWidgetPreflight(request({ path: "/api/widget/messages", method: "POST", ip: "1.1.1.2" })),
    ).toBe(false);
    expect(
      limiter.rateLimitWidgetPreflight(request({ path: "/api/widget/messages", method: "POST", ip: "1.1.1.3" })),
    ).toBe(true);
    vi.advanceTimersByTime(WIDGET_RATE_LIMITS.windowMs + 1);
    expect(
      limiter.rateLimitWidgetPreflight(request({ path: "/api/widget/messages", method: "POST", ip: "1.1.1.2" })),
    ).toBe(true);
  });
});

describe("session-mint limiter (issue #81)", () => {
  it("caps mints per IP even when every request claims a fresh token", () => {
    let admitted = 0;
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint + 20; i++) {
      if (
        limiter.rateLimitWidgetSessionMint(
          request({ path: "/api/widget/session", method: "POST", ip: "4.4.4.4", tokenHeader: `fresh-${i}` }),
        )
      ) {
        admitted += 1;
      }
    }
    expect(admitted).toBe(WIDGET_RATE_LIMITS.sessionMint);
  });

  it("keeps IPs in separate mint buckets", () => {
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint; i++) {
      expect(
        limiter.rateLimitWidgetSessionMint(request({ path: "/api/widget/session", method: "POST", ip: "4.4.4.5" })),
      ).toBe(true);
    }
    expect(
      limiter.rateLimitWidgetSessionMint(request({ path: "/api/widget/session", method: "POST", ip: "4.4.4.5" })),
    ).toBe(false);
    expect(
      limiter.rateLimitWidgetSessionMint(request({ path: "/api/widget/session", method: "POST", ip: "4.4.4.6" })),
    ).toBe(true);
  });

  it("rejected mints do not extend the saturation", () => {
    vi.useFakeTimers();
    const ip = "4.4.4.7";
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint; i++) {
      expect(limiter.rateLimitWidgetSessionMint(request({ path: "/api/widget/session", method: "POST", ip }))).toBe(true);
    }
    for (let i = 0; i < 100; i++) {
      expect(
        limiter.rateLimitWidgetSessionMint(request({ path: "/api/widget/session", method: "POST", ip, tokenHeader: `spam-${i}` })),
      ).toBe(false);
    }
    vi.advanceTimersByTime(WIDGET_RATE_LIMITS.windowMs + 1);
    expect(limiter.rateLimitWidgetSessionMint(request({ path: "/api/widget/session", method: "POST", ip }))).toBe(true);
  });
});

describe("trusted client-IP header (issue #81)", () => {
  const ENV_KEY = "TRUSTED_PROXY_HEADER";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  function requestWithHeaders(headers: Record<string, string>) {
    return new NextRequest(new URL("http://localhost:3000/api/widget/session"), {
      method: "POST",
      headers: new Headers(headers),
    });
  }

  it("reads only the configured header and ignores a spoofed x-forwarded-for", () => {
    process.env[ENV_KEY] = "cf-connecting-ip";
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint; i++) {
      expect(
        limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "cf-connecting-ip": "2.2.2.2", "x-forwarded-for": "2.2.2.2" })),
      ).toBe(true);
    }
    // Same real client via the trusted header, now claiming a fresh XFF.
    expect(
      limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "cf-connecting-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })),
    ).toBe(false);
    // A different real client is still admitted.
    expect(
      limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "cf-connecting-ip": "3.3.3.3", "x-forwarded-for": "2.2.2.2" })),
    ).toBe(true);
  });

  it("accepts the configured header name in any case and fails closed without the header", () => {
    process.env[ENV_KEY] = "CF-Connecting-IP";
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint; i++) {
      expect(limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "cf-connecting-ip": "5.5.5.5" }))).toBe(true);
    }
    // No trusted header at all: every such client shares the "unknown"
    // bucket (stricter, never more permissive than XFF would be).
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint; i++) {
      expect(limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "x-forwarded-for": "6.6.6.6" }))).toBe(true);
    }
    expect(limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "x-forwarded-for": "6.6.6.7" }))).toBe(false);
  });

  it("keys on the last x-forwarded-for entry while TRUSTED_PROXY_HEADER is unset (issue #219)", () => {
    delete process.env[ENV_KEY];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint; i++) {
      expect(
        limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "x-forwarded-for": `spoof-${i}, 7.7.7.8` })),
      ).toBe(true);
    }
    // Rotating the client-supplied prefix buys no fresh bucket.
    expect(
      limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "x-forwarded-for": "another-spoof, 7.7.7.8" })),
    ).toBe(false);
    // A client claiming the burned address in the prefix is not penalised.
    expect(
      limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "x-forwarded-for": "7.7.7.8, 7.7.7.9" })),
    ).toBe(true);
  });

  it("fails open and warns once when no client IP can be determined (issue #219)", () => {
    delete process.env[ENV_KEY];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < WIDGET_RATE_LIMITS.sessionMint * 3; i++) {
      expect(limiter.rateLimitWidgetSessionMint(requestWithHeaders({}))).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("TRUSTED_PROXY_HEADER");
  });

  it("warns once when x-forwarded-for carries several entries while TRUSTED_PROXY_HEADER is unset (issue #219)", () => {
    delete process.env[ENV_KEY];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "x-forwarded-for": `1.1.1.${i}, 7.7.7.8` }));
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("several entries");
  });

  it("does not warn for a single x-forwarded-for entry", () => {
    delete process.env[ENV_KEY];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    limiter.rateLimitWidgetSessionMint(requestWithHeaders({ "x-forwarded-for": "7.7.7.8" }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("still applies the visitor-token bucket without a client IP", () => {
    delete process.env[ENV_KEY];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const make = () => request({ path: "/api/widget/session", method: "POST", tokenHeader: "tok-no-ip" });
    expect(hitsUntilRejected(make, "session")).toBe(WIDGET_RATE_LIMITS.session);
  });
});

describe("API-token failure limiter and client IP (issue #219)", () => {
  const ENV_KEY = "TRUSTED_PROXY_HEADER";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    vi.restoreAllMocks();
  });

  const fail = (headers: Record<string, string>) => {
    limiter.recordApiTokenAuthFailure({ headers: new Headers(headers) });
  };

  it("an attacker spoofing a victim's address cannot lock the victim out behind a proxy", () => {
    // Behind a proxy the attacker's own address is the last entry; the victim is only a forged prefix.
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenFailure; i++) fail({ "x-forwarded-for": "198.51.100.7, 203.0.113.66" });
    expect(limiter.apiTokenAuthBlocked({ headers: new Headers({ "x-forwarded-for": "198.51.100.7" }) })).toBe(false);
    expect(limiter.apiTokenAuthBlocked({ headers: new Headers({ "x-forwarded-for": "203.0.113.66" }) })).toBe(true);
  });

  it("rotating forged prefixes does not dodge the limit", () => {
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenFailure; i++) fail({ "x-forwarded-for": `10.0.0.${i}, 203.0.113.66` });
    expect(limiter.apiTokenAuthBlocked({ headers: new Headers({ "x-forwarded-for": "10.9.9.9, 203.0.113.66" }) })).toBe(true);
  });

  it("with TRUSTED_PROXY_HEADER set, the configured header alone decides", () => {
    process.env[ENV_KEY] = "cf-connecting-ip";
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenFailure; i++) {
      fail({ "cf-connecting-ip": "203.0.113.66", "x-forwarded-for": `forged-${i}` });
    }
    expect(
      limiter.apiTokenAuthBlocked({ headers: new Headers({ "cf-connecting-ip": "203.0.113.66", "x-forwarded-for": "fresh" }) }),
    ).toBe(true);
    expect(limiter.apiTokenAuthBlocked({ headers: new Headers({ "cf-connecting-ip": "203.0.113.67" }) })).toBe(false);
  });

  it("without a determinable client IP nobody is blocked or counted (no shared bucket)", () => {
    for (let i = 0; i < WIDGET_RATE_LIMITS.apiTokenFailure * 2; i++) fail({});
    expect(limiter.apiTokenAuthBlocked({ headers: new Headers() })).toBe(false);
  });
});
