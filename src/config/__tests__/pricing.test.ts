import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLANS, formatCount } from "@/config/pricing";

describe("PLANS (single source shared with src/lib/usage.ts)", () => {
  const originalLimit = process.env.FREE_TIER_CONVERSATION_LIMIT;
  const originalProLimit = process.env.PRO_TIER_CONVERSATION_LIMIT;
  const originalGrace = process.env.USAGE_GRACE_DAYS;

  beforeEach(() => {
    delete process.env.FREE_TIER_CONVERSATION_LIMIT;
    delete process.env.PRO_TIER_CONVERSATION_LIMIT;
    delete process.env.USAGE_GRACE_DAYS;
  });

  afterEach(() => {
    if (originalLimit === undefined) delete process.env.FREE_TIER_CONVERSATION_LIMIT;
    else process.env.FREE_TIER_CONVERSATION_LIMIT = originalLimit;
    if (originalProLimit === undefined) delete process.env.PRO_TIER_CONVERSATION_LIMIT;
    else process.env.PRO_TIER_CONVERSATION_LIMIT = originalProLimit;
    if (originalGrace === undefined) delete process.env.USAGE_GRACE_DAYS;
    else process.env.USAGE_GRACE_DAYS = originalGrace;
  });

  it("ships the decided tier shape (issue #15: Free $0/100/1 agent, Pro $39/1000/unlimited agents)", () => {
    expect(PLANS.free).toMatchObject({
      id: "free",
      name: "Free",
      priceUsd: 0,
      monthlyConversations: 100,
      agents: 1,
      graceDays: 30,
    });
    expect(PLANS.pro).toMatchObject({
      id: "pro",
      name: "Pro",
      priceUsd: 39,
      monthlyConversations: 1000,
      agents: null,
      graceDays: 30,
    });
  });

  it("still honours the environment overrides", async () => {
    process.env.FREE_TIER_CONVERSATION_LIMIT = "250";
    process.env.PRO_TIER_CONVERSATION_LIMIT = "5000";
    process.env.USAGE_GRACE_DAYS = "45";
    vi.resetModules();
    const mod = await import("@/config/pricing");
    expect(mod.PLANS.free.monthlyConversations).toBe(250);
    expect(mod.PLANS.pro.monthlyConversations).toBe(5000);
    expect(mod.PLANS.free.graceDays).toBe(45);
    expect(mod.PLANS.pro.graceDays).toBe(45);
  });

  it("never lets the grace override drop below the promised 30-day floor", async () => {
    process.env.USAGE_GRACE_DAYS = "7";
    vi.resetModules();
    const mod = await import("@/config/pricing");
    expect(mod.PLANS.free.graceDays).toBe(30);
    expect(mod.PLANS.pro.graceDays).toBe(30);
  });

  it("is the same object re-exported from src/lib/usage.ts", async () => {
    vi.resetModules();
    const [pricing, usage] = await Promise.all([
      import("@/config/pricing"),
      import("@/lib/usage"),
    ]);
    expect(usage.PLANS).toBe(pricing.PLANS);
  });
});

describe("display formatting", () => {
  it("formats allowances for display", () => {
    expect(formatCount(100)).toBe("100");
    expect(formatCount(1000)).toBe("1,000");
  });
});
