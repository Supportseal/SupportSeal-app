import { describe, expect, it } from "vitest";

import {
  deserializePlanIntent,
  parsePlanIntent,
  planCheckoutPath,
  planOnboardingPath,
  serializePlanIntent,
} from "@/lib/plan-intent";

describe("plan intent from the marketing pricing page", () => {
  it("accepts the paid plans and both intervals, defaulting to monthly", () => {
    expect(parsePlanIntent("pro")).toEqual({ plan: "pro", interval: "month" });
    expect(parsePlanIntent("business", "year")).toEqual({ plan: "business", interval: "year" });
  });

  it("ignores free, unknown plans and unknown intervals", () => {
    expect(parsePlanIntent("free")).toBeNull();
    expect(parsePlanIntent("enterprise")).toBeNull();
    expect(parsePlanIntent(undefined)).toBeNull();
    expect(parsePlanIntent("pro", "week")).toBeNull();
    expect(parsePlanIntent(["pro"])).toBeNull();
  });

  it("round-trips through the cookie value and rejects tampered values", () => {
    const intent = { plan: "business", interval: "year" } as const;
    expect(deserializePlanIntent(serializePlanIntent(intent))).toEqual(intent);
    expect(deserializePlanIntent("business.decade")).toBeNull();
    expect(deserializePlanIntent("")).toBeNull();
    expect(deserializePlanIntent(undefined)).toBeNull();
  });

  it("points at the billing page with the plan preselected", () => {
    expect(planCheckoutPath({ plan: "pro", interval: "year" })).toBe("/settings/billing?plan=pro&interval=year");
  });
});

describe("planOnboardingPath", () => {
  it("keeps the plan on the way into onboarding", () => {
    expect(planOnboardingPath({ plan: "pro", interval: "year" })).toBe("/onboarding?plan=pro&interval=year");
  });
});
