import { expect, test, type Page } from "@playwright/test";

import {
  stripeEventPayload,
  stripeSignatureHeader,
  uniqueStripeEventId,
  type StripeEventObject,
} from "../../src/test/stripe-signing";
import { APP_ORIGIN, onboardWorkspaceWithProduct, uniqueAccount } from "./helpers";

const STRIPE_API = "https://api.stripe.com";

type StripeEnv = { secretKey: string; priceId: string; webhookSecret: string };

function resolveStripeE2e(): { env: StripeEnv | null; skipReason: string | null } {
  if (process.env.STRIPE_E2E !== "1") {
    return { env: null, skipReason: "set STRIPE_E2E=1 with test-mode Stripe env to enable" };
  }
  const missing = (
    [
      ["STRIPE_SECRET_KEY", process.env.STRIPE_SECRET_KEY],
      ["STRIPE_PRO_PRICE_ID", process.env.STRIPE_PRO_PRICE_ID],
      ["STRIPE_WEBHOOK_SECRET", process.env.STRIPE_WEBHOOK_SECRET],
    ] as const
  )
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    return { env: null, skipReason: `STRIPE_E2E=1 but missing ${missing.join(", ")}` };
  }
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!secretKey.startsWith("sk_test_")) {
    return { env: null, skipReason: "STRIPE_SECRET_KEY must be a test-mode key (sk_test_...)" };
  }
  return {
    env: {
      secretKey,
      priceId: process.env.STRIPE_PRO_PRICE_ID?.trim() ?? "",
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
    },
    skipReason: null,
  };
}

const resolved = resolveStripeE2e();
const stripeEnv = resolved.env;

type CheckoutSession = {
  id: string;
  metadata?: { workspaceId?: string };
  subscription?: string | null;
  payment_status?: string;
};

async function stripeGet(path: string): Promise<CheckoutSession> {
  if (!stripeEnv) throw new Error("stripe e2e env unresolved");
  const response = await fetch(`${STRIPE_API}${path}`, {
    headers: { authorization: `Bearer ${stripeEnv.secretKey}` },
  });
  expect(response.ok, `GET ${path} -> HTTP ${response.status}`).toBeTruthy();
  return (await response.json()) as CheckoutSession;
}

async function postSignedEvent(type: string, object: StripeEventObject): Promise<Response> {
  if (!stripeEnv) throw new Error("stripe e2e env unresolved");
  const payload = stripeEventPayload({ id: uniqueStripeEventId(), type, object });
  return fetch(`${APP_ORIGIN}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": stripeSignatureHeader({ payload, secret: stripeEnv.webhookSecret }),
    },
    body: payload,
  });
}

function appUrlPattern(): RegExp {
  const escaped = APP_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}/settings/billing`);
}

async function fillStripeCardForm(page: Page, email: string, name: string): Promise<void> {
  const card = page
    .locator("#cardNumber")
    .or(page.getByRole("textbox", { name: "Card number" }))
    .or(page.getByPlaceholder(/1234\s*1234/u));
  await card.waitFor({ state: "visible", timeout: 60_000 });

  const emailInput = page.locator("#email");
  if (await emailInput.isVisible()) {
    await emailInput.fill(email);
  } else {
    await expect(page.getByText(email, { exact: true })).toBeVisible();
  }

  await card.fill("4242424242424242");
  const expiry = page
    .locator("#cardExpiry")
    .or(page.locator("#expiry"))
    .or(page.getByRole("textbox", { name: "Expiration" }))
    .or(page.getByPlaceholder(/MM\s*\/?\s*YY/u));
  await expiry.fill("12/34");
  const cvc = page
    .locator("#cardCvc")
    .or(page.locator("#cvc"))
    .or(page.getByRole("textbox", { name: /CVC|CVV/u }))
    .or(page.getByPlaceholder(/CV[CV]/iu));
  await cvc.fill("424");
  const cardholder = page
    .locator("#cardholderName")
    .or(page.locator("#billingName"))
    .or(page.getByRole("textbox", { name: "Cardholder name" }));
  if (await cardholder.first().isVisible()) {
    await cardholder.first().fill(name);
  }
  const postalCode = page.locator("#billingPostalCode").or(page.getByPlaceholder(/ZIP|Postal/iu));
  if (await postalCode.first().isVisible()) {
    await postalCode.first().fill("94103");
  }
  const saveWithLink = page.getByRole("checkbox", { name: /Save my information with Link/iu });
  if ((await saveWithLink.isVisible()) && (await saveWithLink.isChecked())) {
    await saveWithLink.uncheck();
  }
}

test.describe.serial("stripe hosted checkout (env-gated)", () => {
  test.skip(stripeEnv === null, resolved.skipReason ?? "stripe e2e disabled");

  const account = uniqueAccount();
  const productDomain = `${account.email.split("@")[0]}.test`;

  let adminPage: Page;
  let checkoutSessionId = "";
  let workspaceId = "";
  let subscriptionId = "";

  test.beforeAll(async ({ browser }) => {
    adminPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  });

  test.afterAll(async () => {
    await adminPage?.context().close();
    if (!stripeEnv || !subscriptionId) return;
    try {
      const response = await fetch(`${STRIPE_API}/v1/subscriptions/${subscriptionId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${stripeEnv.secretKey}` },
      });
      if (!response.ok) {
        console.warn(`[stripe-e2e] cleanup: cancelling ${subscriptionId} -> HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn(`[stripe-e2e] cleanup: cancelling ${subscriptionId} failed`, error);
    }
  });

  test("admin starts an upgrade and reaches stripe checkout", async () => {
    test.setTimeout(180_000);
    await onboardWorkspaceWithProduct(adminPage, account, { name: "Billing Tool", domain: productDomain });

    await adminPage.goto("/settings/billing");
    await expect(adminPage.getByText("0 conversations of 100")).toBeVisible();
    await expect(adminPage.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();

    await adminPage.getByRole("button", { name: "Upgrade to Pro" }).click();
    await expect(adminPage).toHaveURL(/https:\/\/checkout\.stripe\.com\//u, { timeout: 120_000 });

    const url = adminPage.url().split("#")[0] ?? "";
    checkoutSessionId = url.match(/cs_test_[A-Za-z0-9]+/u)?.[0] ?? "";
    expect(checkoutSessionId, `no checkout session id in ${url}`).not.toBe("");
  });

  test("the app-created checkout session carries workspace metadata", async () => {
    const session = await stripeGet(`/v1/checkout/sessions/${checkoutSessionId}`);
    expect(session.id).toBe(checkoutSessionId);
    expect(session.metadata?.workspaceId, "checkout session is missing workspaceId metadata").toBeTruthy();
    workspaceId = session.metadata?.workspaceId ?? "";
  });

  test("the test card completes stripe hosted checkout", async () => {
    test.setTimeout(240_000);
    await fillStripeCardForm(adminPage, account.email, account.name);
    await adminPage.getByRole("button", { name: /^(Subscribe|Pay|Start trial)$/u }).click();
    await expect(adminPage).toHaveURL(appUrlPattern(), { timeout: 180_000 });

    const session = await stripeGet(`/v1/checkout/sessions/${checkoutSessionId}`);
    expect(session.payment_status).toBe("paid");
    if (typeof session.subscription === "string") subscriptionId = session.subscription;
  });

  test("signed subscription events flip the workspace to Pro", async () => {
    const forged = await fetch(`${APP_ORIGIN}/api/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1700000000,v1=deadbeef" },
      body: stripeEventPayload({
        id: uniqueStripeEventId(),
        type: "customer.subscription.updated",
        object: { id: "sub_forged", object: "subscription", status: "active", metadata: { workspaceId } },
      }),
    });
    expect(forged.status).toBe(400);

    const completed = await postSignedEvent("checkout.session.completed", {
      id: checkoutSessionId,
      object: "checkout.session",
      payment_status: "paid",
      metadata: { workspaceId },
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ received: true });

    const created = await postSignedEvent("customer.subscription.created", {
      id: subscriptionId || `sub_${uniqueStripeEventId().slice(4, 18)}`,
      object: "subscription",
      status: "active",
      metadata: { workspaceId },
    });
    expect(created.status).toBe(200);

    await adminPage.goto("/settings/billing");
    await expect(adminPage.getByText(/0 conversations of 1,?000/u)).toBeVisible();
    await expect(adminPage.getByRole("button", { name: "Upgrade to Pro" })).toHaveCount(0);
  });

  test("subscription deletion returns the workspace to Free", async () => {
    const deleted = await postSignedEvent("customer.subscription.deleted", {
      id: subscriptionId || `sub_${uniqueStripeEventId().slice(4, 18)}`,
      object: "subscription",
      status: "canceled",
      metadata: { workspaceId },
    });
    expect(deleted.status).toBe(200);

    await adminPage.goto("/settings/billing");
    await expect(adminPage.getByText("0 conversations of 100")).toBeVisible();
    await expect(adminPage.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
  });
});
