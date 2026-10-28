import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveAnalytics,
  sanitizeEventData,
  track,
  UMAMI_BEFORE_SEND_NAME,
  UMAMI_BEFORE_SEND_SOURCE,
} from "@/lib/analytics";

type Payload = { url?: string; referrer?: string; title?: string };
type BeforeSend = (type: string, payload: Payload) => Payload | null;

/** Runs the inlined hook against a fake window at `href`. */
function beforeSend(href: string): BeforeSend {
  const location = new URL(href);
  const fakeWindow: Record<string, unknown> = { location };
  new Function("window", UMAMI_BEFORE_SEND_SOURCE)(fakeWindow);
  return fakeWindow[UMAMI_BEFORE_SEND_NAME] as BeforeSend;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveAnalytics (hosted Umami, off unless configured)", () => {
  it("is off without both settings", () => {
    expect(resolveAnalytics({}).enabled).toBe(false);
    expect(resolveAnalytics({ NEXT_PUBLIC_UMAMI_SCRIPT_URL: "https://a.example.com/script.js" }).enabled).toBe(false);
    expect(resolveAnalytics({ NEXT_PUBLIC_UMAMI_WEBSITE_ID: "w-1" }).enabled).toBe(false);
  });

  it("turns on with an https script URL and a website id", () => {
    expect(
      resolveAnalytics({
        NEXT_PUBLIC_UMAMI_SCRIPT_URL: " https://analytics.example.com/script.js ",
        NEXT_PUBLIC_UMAMI_WEBSITE_ID: " w-1 ",
      }),
    ).toEqual({ enabled: true, scriptUrl: "https://analytics.example.com/script.js", websiteId: "w-1" });
  });

  it("refuses non-https or attribute-breaking script URLs", () => {
    for (const url of ["http://a.example.com/s.js", 'https://a.example.com/s.js"onload="x', "javascript:alert(1)"]) {
      expect(resolveAnalytics({ NEXT_PUBLIC_UMAMI_SCRIPT_URL: url, NEXT_PUBLIC_UMAMI_WEBSITE_ID: "w" }).enabled).toBe(false);
    }
  });

  it("is never configured by the self-hosted compose file, only the hosted one", () => {
    const root = path.resolve(__dirname, "../../..");
    expect(readFileSync(path.join(root, "docker-compose.yml"), "utf8")).not.toMatch(/UMAMI/);
    expect(readFileSync(path.join(root, "docker-compose.hosted.yml"), "utf8")).toMatch(/NEXT_PUBLIC_UMAMI_WEBSITE_ID/);
  });
});

describe("sanitizeEventData (no personal data in events)", () => {
  it("keeps enum-like strings, numbers and booleans", () => {
    expect(sanitizeEventData({ plan: "pro", attachments: 2, saved_reply: true })).toEqual({
      plan: "pro",
      attachments: 2,
      saved_reply: true,
    });
  });

  it("drops free text, emails, long strings and odd keys", () => {
    expect(
      sanitizeEventData({
        email: "dana@example.com",
        note: "Hello there",
        long: "x".repeat(41),
        "Bad Key": "ok",
        nan: Number.NaN,
      }),
    ).toBeUndefined();
  });
});

describe("track", () => {
  it("is a no-op without Umami (self-hosted, blocked, server)", () => {
    expect(() => track("reply_sent")).not.toThrow();
    vi.stubGlobal("window", {});
    expect(() => track("reply_sent")).not.toThrow();
  });

  it("forwards sanitised data to Umami and swallows its errors", () => {
    const calls: unknown[][] = [];
    vi.stubGlobal("window", { umami: { track: (...args: unknown[]) => calls.push(args) } });
    track("checkout_started", { plan: "pro", email: "a@b.co" });
    expect(calls).toEqual([["checkout_started", { plan: "pro" }]]);
    vi.stubGlobal("window", {
      umami: {
        track: () => {
          throw new Error("boom");
        },
      },
    });
    expect(() => track("reply_sent")).not.toThrow();
  });
});

describe("Umami before-send hook (URL scrubbing)", () => {
  const send = beforeSend("https://dashboard.supportseal.app/inbox");

  it("replaces ids and tokens in paths", () => {
    expect(send("event", { url: "/inbox/3f1c2a9e-1b2c-4d5e-8f90-1234567890ab" })?.url).toBe("/inbox/:id");
    expect(send("event", { url: "/settings/products/3f1c2a9e-1b2c-4d5e-8f90-1234567890ab" })?.url).toBe(
      "/settings/products/:id",
    );
    expect(send("event", { url: "/invite/abc" })?.url).toBe("/invite/:token");
    expect(send("event", { url: "/onboarding/product" })?.url).toBe("/onboarding/product");
  });

  it("drops query strings and hashes from full URLs too", () => {
    expect(
      send("event", { url: "https://dashboard.supportseal.app/reset-password?token=secret123#x" })?.url,
    ).toBe("https://dashboard.supportseal.app/reset-password");
  });

  it("keeps only the origin of outside referrers and scrubs internal ones", () => {
    const out = send("event", { url: "/inbox", referrer: "https://news.example.com/item?id=42" });
    expect(out?.referrer).toBe("https://news.example.com/");
    expect(
      send("event", {
        url: "/inbox",
        referrer: "https://dashboard.supportseal.app/inbox/3f1c2a9e-1b2c-4d5e-8f90-1234567890ab?tab=x",
      })?.referrer,
    ).toBe("https://dashboard.supportseal.app/inbox/:id");
  });

  it("strips the unread-count prefix from titles", () => {
    expect(send("event", { url: "/inbox", title: "(12) Inbox | SupportSeal" })?.title).toBe("Inbox | SupportSeal");
  });

  it("sends nothing from the widget preview", () => {
    expect(beforeSend("https://dashboard.supportseal.app/widget-preview?p=1")("event", { url: "/widget-preview" })).toBeNull();
  });
});
