import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkStripePriceMode,
  evaluateBillingConfig,
  guardBillingConfig,
  logWebhookSignatureFailureHint,
  resetStripeConfigGuardForTest,
  stripeKeyMode,
  webhookSignatureFailureHint,
} from "@/lib/stripe-config";

// Fake credentials only — never a real key (issue #25 ground rules).
const TEST_KEY = "sk_test_fakekey";
const LIVE_KEY = "sk_live_fakekey";
const WHSEC = "whsec_fakesecret";

const VALID_TEST_ENV = {
  STRIPE_SECRET_KEY: TEST_KEY,
  STRIPE_WEBHOOK_SECRET: WHSEC,
  STRIPE_PRO_MONTHLY_PRICE_ID: "price_pro_m",
  STRIPE_PRO_ANNUAL_PRICE_ID: "price_pro_y",
  STRIPE_BUSINESS_MONTHLY_PRICE_ID: "price_biz_m",
  STRIPE_BUSINESS_ANNUAL_PRICE_ID: "price_biz_y",
};

/** No problem text may echo a credential value (FR-OPS-01). */
function problemsText(env: Record<string, string | undefined>): string {
  const guard = evaluateBillingConfig(env);
  expect(guard.status).toBe("misconfigured");
  return (guard as { problems: string[] }).problems.join(" | ");
}

beforeEach(() => {
  resetStripeConfigGuardForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stripeKeyMode", () => {
  it.each([
    ["sk_test_fakekey", "test"],
    ["rk_test_fakekey", "test"],
    ["sk_live_fakekey", "live"],
    ["rk_live_fakekey", "live"],
  ])("reads the mode of %s", (key, mode) => {
    expect(stripeKeyMode(key)).toBe(mode);
  });

  it.each([
    ["pk_live_fakekey"],
    ["sk_live"], // no mode-terminated prefix
    ["whsec_fakesecret"],
    ["  "],
    [undefined],
  ])("does not recognise %j as a secret key", (key) => {
    expect(stripeKeyMode(key)).not.toBe("test");
    expect(stripeKeyMode(key)).not.toBe("live");
  });
});

describe("evaluateBillingConfig", () => {
  it("is inert when no Stripe variable is set (FR-HOST-01)", () => {
    expect(evaluateBillingConfig({})).toEqual({ status: "unconfigured" });
  });

  it.each([
    ["test", TEST_KEY],
    ["live", LIVE_KEY],
  ])("accepts a consistent %s-mode configuration", (mode, key) => {
    expect(evaluateBillingConfig({ ...VALID_TEST_ENV, STRIPE_SECRET_KEY: key })).toEqual({
      status: "ok",
      mode,
    });
  });

  it("accepts a key with neither webhook secret nor prices (webhook optional)", () => {
    expect(evaluateBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY })).toEqual({ status: "ok", mode: "test" });
  });

  it("rejects a secret key without a mode marker (e.g. a publishable key)", () => {
    const text = problemsText({ ...VALID_TEST_ENV, STRIPE_SECRET_KEY: "pk_live_fakekey" });
    expect(text).toContain("STRIPE_SECRET_KEY");
  });

  it("rejects an API key pasted into STRIPE_WEBHOOK_SECRET", () => {
    const text = problemsText({ ...VALID_TEST_ENV, STRIPE_WEBHOOK_SECRET: TEST_KEY });
    expect(text).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it.each([
    ["STRIPE_PRO_MONTHLY_PRICE_ID"],
    ["STRIPE_PRO_ANNUAL_PRICE_ID"],
    ["STRIPE_BUSINESS_MONTHLY_PRICE_ID"],
    ["STRIPE_BUSINESS_ANNUAL_PRICE_ID"],
  ])("rejects a lookup key or secret in %s", (envVar) => {
    const text = problemsText({
      ...VALID_TEST_ENV,
      [envVar]: envVar.includes("PRO") ? "supportseal_pro_monthly" : WHSEC,
    });
    expect(text).toContain(envVar);
  });

  it("rejects webhook or price variables set without STRIPE_SECRET_KEY", () => {
    const text = problemsText({ STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_PRO_MONTHLY_PRICE_ID: "price_pro_m" });
    expect(text).toContain("STRIPE_SECRET_KEY");
    expect(text).toContain("STRIPE_PRO_MONTHLY_PRICE_ID");
  });

  it("never echoes credential values in problem text", () => {
    const text = problemsText({
      STRIPE_SECRET_KEY: "sk_test_leakprobe",
      STRIPE_WEBHOOK_SECRET: "whsec_leakprobe",
      STRIPE_PRO_MONTHLY_PRICE_ID: "price_leakprobe",
      STRIPE_PRO_ANNUAL_PRICE_ID: "notaprice_leakprobe",
    });
    expect(text).not.toContain("leakprobe");
  });
});

describe("guardBillingConfig", () => {
  it("logs a mismatch loudly, once per problem set", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { STRIPE_SECRET_KEY: "pk_live_fakekey" };

    guardBillingConfig(env);
    guardBillingConfig(env);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      "[billing] Stripe configuration is inconsistent; billing is refused until it is fixed",
      { problems: expect.arrayContaining([expect.stringContaining("STRIPE_SECRET_KEY")]) },
    );

    // A different problem set must warn again; a fixed one stays silent.
    guardBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_WEBHOOK_SECRET: TEST_KEY });
    expect(logged).toHaveBeenCalledTimes(2);
    guardBillingConfig({ STRIPE_SECRET_KEY: TEST_KEY });
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});

describe("checkStripePriceMode", () => {
  function stubPriceFetch(status: number, message?: string) {
    const fetchMock = vi.fn(async () =>
      new Response(
        message ? JSON.stringify({ error: { message } }) : JSON.stringify({ id: "price_x", object: "price" }),
        { status, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
  });

  it("reports a price the key can read as visible", async () => {
    stubPriceFetch(200);
    await expect(checkStripePriceMode({ envVar: "STRIPE_PRO_MONTHLY_PRICE_ID", priceId: "price_pro_m" })).resolves.toEqual({ state: "visible" });
  });

  it("reports the mixed-mode case: live key, price only in test (No such price)", async () => {
    stubPriceFetch(404, "No such price: 'price_wrong'");
    const visibility = await checkStripePriceMode({
      envVar: "STRIPE_PRO_MONTHLY_PRICE_ID",
      priceId: "price_wrong",
    });
    expect(visibility).toEqual({
      state: "missing",
      problem: expect.stringContaining("STRIPE_PRO_MONTHLY_PRICE_ID"),
    });
    expect(visibility.state === "missing" && visibility.problem).toContain("test-mode");
    // the failing price id value is configuration, but keep messages to names and modes
    expect(visibility.state === "missing" && visibility.problem).not.toContain("price_wrong");
  });

  it("fails open on transient errors (never blocks checkout on a Stripe blip)", async () => {
    stubPriceFetch(503, "boom");
    await expect(checkStripePriceMode({ envVar: "X", priceId: "price_x" })).resolves.toEqual({ state: "unknown" });
  });

  it("fails open when Stripe is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(checkStripePriceMode({ envVar: "X", priceId: "price_x" })).resolves.toEqual({ state: "unknown" });
  });

  it("caches per mode and price for the TTL", async () => {
    const fetchMock = stubPriceFetch(200);
    await checkStripePriceMode({ envVar: "X", priceId: "price_a" });
    await checkStripePriceMode({ envVar: "X", priceId: "price_a" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    process.env.STRIPE_SECRET_KEY = LIVE_KEY;
    await checkStripePriceMode({ envVar: "X", priceId: "price_a" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("webhookSignatureFailureHint", () => {
  it("names the opposite mode for a live key", () => {
    const hint = webhookSignatureFailureHint({ STRIPE_SECRET_KEY: LIVE_KEY });
    expect(hint).toContain("live-mode");
    expect(hint).toContain("test-mode endpoint");
  });

  it("names the opposite mode for a test key", () => {
    const hint = webhookSignatureFailureHint({ STRIPE_SECRET_KEY: TEST_KEY });
    expect(hint).toContain("test-mode");
    expect(hint).toContain("live-mode endpoint");
  });

  it("stays silent without a recognised key mode", () => {
    expect(webhookSignatureFailureHint({})).toBeNull();
    expect(webhookSignatureFailureHint({ STRIPE_SECRET_KEY: "pk_live_fakekey" })).toBeNull();
  });

  it("logs the hint at most once per hour", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logWebhookSignatureFailureHint({ STRIPE_SECRET_KEY: LIVE_KEY });
    logWebhookSignatureFailureHint({ STRIPE_SECRET_KEY: LIVE_KEY });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
