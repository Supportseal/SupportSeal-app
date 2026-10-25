import { describe, expect, it } from "vitest";

import { inboundDomain, managedSender } from "@/lib/email/addresses";
import {
  LOOP_HEADER,
  detectInboundLoop,
  isAutomaticMail,
  isOwnAddress,
  outboundBlockReason,
  stampHeaders,
} from "@/lib/email/loop-guard";
import { normalizeSupportEmail } from "@/lib/products";

const product = { supportEmail: "Support@Acme.com", inboundEmail: "product_abc@inbound.example.com" };
const plain = { autoSubmitted: null, precedence: null, xAutoreply: null, messageId: "<abc@mail.sam.dev>" };

describe("isOwnAddress / outboundBlockReason", () => {
  it("matches the support, forwarding, managed-sender and reply+ addresses case-insensitively", () => {
    expect(isOwnAddress("support@acme.com", product)).toBe(true);
    expect(isOwnAddress("SUPPORT@ACME.COM", product)).toBe(true);
    expect(isOwnAddress("Product_ABC@inbound.example.com", product)).toBe(true);
    expect(isOwnAddress(managedSender(), product)).toBe(true);
    expect(isOwnAddress(`reply+tok123@${inboundDomain()}`, product)).toBe(true);
  });

  it("does not match customers, other mailboxes on the support domain or empty values", () => {
    expect(isOwnAddress("sam@fastmail.dev", product)).toBe(false);
    expect(isOwnAddress("billing@acme.com", product)).toBe(false);
    expect(isOwnAddress("reply+tok@elsewhere.dev", product)).toBe(false);
    expect(isOwnAddress("", product)).toBe(false);
    expect(isOwnAddress(null, {})).toBe(false);
  });

  it("explains a blocked recipient and passes ordinary ones", () => {
    expect(outboundBlockReason("support@acme.com", product)).toMatch(/mail loop guard/u);
    expect(outboundBlockReason("sam@fastmail.dev", product)).toBeNull();
  });
});

describe("isAutomaticMail", () => {
  it.each([
    [{ autoSubmitted: "auto-replied" }, true],
    [{ autoSubmitted: "Auto-Generated" }, true],
    [{ autoSubmitted: "no" }, false],
    [{ precedence: "bulk" }, true],
    [{ precedence: "auto_reply" }, true],
    [{ precedence: "JUNK" }, true],
    [{ precedence: "first-class" }, false],
    [{ xAutoreply: "yes" }, true],
    [{}, false],
  ])("%j -> %s", (headers, expected) => {
    expect(isAutomaticMail({ autoSubmitted: null, precedence: null, xAutoreply: null, ...headers })).toBe(expected);
  });
});

describe("detectInboundLoop", () => {
  const detect = (from: string, headers: Partial<Parameters<typeof detectInboundLoop>[0]["headers"]> = {}) =>
    detectInboundLoop({ from, headers: { ...plain, ...headers }, product });

  it("passes an ordinary customer mail", () => {
    expect(detect("sam@fastmail.dev")).toBeNull();
    // Auto-Submitted: no is explicitly "not automatic".
    expect(detect("sam@fastmail.dev", { autoSubmitted: "no" })).toBeNull();
  });

  it("flags mail carrying our stamp header", () => {
    expect(detect("sam@fastmail.dev", { xSupportSeal: inboundDomain() })).toMatch(/X-SupportSeal/u);
    expect(detect("sam@fastmail.dev", { xSupportSeal: ` ${inboundDomain().toUpperCase()} ` })).toMatch(/X-SupportSeal/u);
    // A stamp from a different SupportSeal instance is genuine mail.
    expect(detect("sam@fastmail.dev", { xSupportSeal: "other-instance.example" })).toBeNull();
  });

  it("flags a Message-ID issued by this instance, but not same-domain mail of another shape", () => {
    const ours = `<0b5b0d3e-8f0f-4c7e-9c53-2d7b6a1f9e11@${inboundDomain()}>`;
    expect(detect("sam@fastmail.dev", { messageId: ours })).toMatch(/Message-ID/u);
    // Nodemailer's default id shape (8-4-4-12 hex) is ours too.
    expect(detect("sam@fastmail.dev", { messageId: `<0b5b0d3e-8f0f-4c7e-9c53d7b6a1f9@${inboundDomain()}>` })).toMatch(/Message-ID/u);
    // Staff mail on the same domain (e.g. Exchange ids) stays deliverable.
    expect(detect("sam@fastmail.dev", { messageId: `<CAF=abc123@${inboundDomain()}>` })).toBeNull();
    expect(detect("sam@fastmail.dev", { messageId: "<0b5b0d3e-8f0f-4c7e-9c53-2d7b6a1f9e11@other.dev>" })).toBeNull();
  });

  it("flags auto-responses and the product's own addresses as sender", () => {
    expect(detect("sam@fastmail.dev", { precedence: "auto_reply" })).toMatch(/auto-response/u);
    expect(detect("support@acme.com")).toMatch(/own support/u);
    expect(detect("product_abc@inbound.example.com")).toMatch(/own support/u);
    expect(detect(managedSender())).toMatch(/own support/u);
  });
});

describe("stampHeaders", () => {
  it("stamps the instance mail domain under X-SupportSeal", () => {
    expect(stampHeaders()).toEqual({ [LOOP_HEADER]: inboundDomain().toLowerCase() });
    expect(LOOP_HEADER).toBe("X-SupportSeal");
  });
});

describe("normalizeSupportEmail", () => {
  const forwarding = { inboundEmail: "product_abc@inbound.example.com" };

  it("lowercases and trims; blank clears", () => {
    expect(normalizeSupportEmail("  Support@Acme.COM ", forwarding)).toEqual({ ok: true, email: "support@acme.com" });
    expect(normalizeSupportEmail("   ", forwarding)).toEqual({ ok: true, email: null });
  });

  it("rejects malformed values, header-injection characters and over-long input", () => {
    for (const bad of ["nope", "a@b", "a b@c.com", "a@b.com, c@d.com", "<a@b.com>", `${"x".repeat(250)}@a.com`]) {
      expect(normalizeSupportEmail(bad, forwarding).ok).toBe(false);
    }
  });

  it("rejects the generated forwarding, managed-sender and reply+ addresses", () => {
    expect(normalizeSupportEmail("product_abc@inbound.example.com", forwarding).ok).toBe(false);
    expect(normalizeSupportEmail(managedSender(), forwarding).ok).toBe(false);
    expect(normalizeSupportEmail(`reply+x@${inboundDomain()}`, forwarding).ok).toBe(false);
  });
});
