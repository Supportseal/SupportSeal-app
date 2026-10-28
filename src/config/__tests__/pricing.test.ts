import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLANS, formatCount, planForWorkspace } from "@/config/pricing";

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

  it("ships the decided tier shape (issue #15: Free $0/100/1 agent, Pro $19 or $190/1000/unlimited agents, Business $99 or $990/unlimited)", () => {
    expect(PLANS.free).toMatchObject({
      id: "free",
      name: "Free",
      priceUsd: { month: 0, year: 0 },
      monthlyConversations: 100,
      agents: 1,
      graceDays: 7,
      pausesAfterGrace: true,
    });
    expect(PLANS.pro).toMatchObject({
      id: "pro",
      name: "Pro",
      priceUsd: { month: 19, year: 190 },
      monthlyConversations: 1000,
      agents: null,
      graceDays: 30,
      pausesAfterGrace: false,
    });
    expect(PLANS.business).toMatchObject({
      id: "business",
      name: "Business",
      priceUsd: { month: 99, year: 990 },
      monthlyConversations: null,
      agents: null,
      graceDays: 30,
      pausesAfterGrace: false,
    });
  });

  it("annual prices are ten months of the monthly price (two months free)", () => {
    for (const plan of [PLANS.pro, PLANS.business]) {
      expect(plan.priceUsd.year).toBe(plan.priceUsd.month * 10);
    }
  });

  it("maps each stored Workspace plan to its shared plan, defaulting to Free", () => {
    expect(planForWorkspace("BUSINESS").id).toBe("business");
    expect(planForWorkspace("PRO").id).toBe("pro");
    expect(planForWorkspace("FREE").id).toBe("free");
    expect(planForWorkspace(undefined).id).toBe("free");
  });

  it("still honours the environment overrides", async () => {
    process.env.FREE_TIER_CONVERSATION_LIMIT = "250";
    process.env.PRO_TIER_CONVERSATION_LIMIT = "5000";
    process.env.USAGE_GRACE_DAYS = "45";
    vi.resetModules();
    const mod = await import("@/config/pricing");
    expect(mod.PLANS.free.monthlyConversations).toBe(250);
    expect(mod.PLANS.pro.monthlyConversations).toBe(5000);
    // Free grace is fixed at 7 days (2026-10-28); the override is for paid plans.
    expect(mod.PLANS.free.graceDays).toBe(7);
    expect(mod.PLANS.pro.graceDays).toBe(45);
  });

  it("never lets the grace override drop paid plans below the 30-day floor", async () => {
    process.env.USAGE_GRACE_DAYS = "7";
    vi.resetModules();
    const mod = await import("@/config/pricing");
    expect(mod.PLANS.free.graceDays).toBe(7);
    expect(mod.PLANS.pro.graceDays).toBe(30);
    expect(mod.PLANS.business.graceDays).toBe(30);
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
