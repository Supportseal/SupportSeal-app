import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyStripeSignature } from "@/lib/stripe";
import { stripeEventPayload, stripeSignatureHeader, uniqueStripeEventId } from "@/test/stripe-signing";

const SECRET = "whsec_unit_test_secret";

const payload = stripeEventPayload({
  id: uniqueStripeEventId(),
  type: "customer.subscription.updated",
  object: { id: "sub_123", object: "subscription", status: "active", metadata: { workspaceId: "ws_1" } },
});

describe("stripe test signing helpers", () => {
  it("round-trips through verifyStripeSignature", () => {
    const header = stripeSignatureHeader({ payload, secret: SECRET });
    expect(verifyStripeSignature({ payload, header, secret: SECRET })).toBe(true);
  });

  it("signs deterministically over timestamp and payload", () => {
    const header = stripeSignatureHeader({ payload, secret: SECRET, timestampSeconds: 1_700_000_000 });
    const expected = createHmac("sha256", SECRET).update(`1700000000.${payload}`).digest("hex");
    expect(header).toBe(`t=1700000000,v1=${expected}`);
  });

  it("rejects a signature made with a different secret", () => {
    const header = stripeSignatureHeader({ payload, secret: "whsec_other" });
    expect(verifyStripeSignature({ payload, header, secret: SECRET })).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const header = stripeSignatureHeader({ payload, secret: SECRET });
    expect(verifyStripeSignature({ payload: payload.replace("active", "past_due"), header, secret: SECRET })).toBe(
      false,
    );
  });

  it("rejects a stale timestamp", () => {
    const stale = Math.floor(Date.now() / 1000) - 400;
    const header = stripeSignatureHeader({ payload, secret: SECRET, timestampSeconds: stale });
    expect(verifyStripeSignature({ payload, header, secret: SECRET })).toBe(false);
  });

  it("accepts any v1 entry during secret rotation", () => {
    const valid = stripeSignatureHeader({ payload, secret: SECRET });
    const rotated = `${valid},v1=${"0".repeat(64)}`;
    expect(verifyStripeSignature({ payload, header: rotated, secret: SECRET })).toBe(true);
  });

  it("builds payloads shaped like webhook events", () => {
    const event = JSON.parse(payload) as {
      id: string;
      type: string;
      data: { object: { status: string; metadata: { workspaceId: string } } };
    };
    expect(event.id).toMatch(/^evt_[0-9a-f]{32}$/u);
    expect(event.type).toBe("customer.subscription.updated");
    expect(event.data.object.status).toBe("active");
    expect(event.data.object.metadata.workspaceId).toBe("ws_1");
    expect(uniqueStripeEventId()).not.toBe(event.id);
  });
});
