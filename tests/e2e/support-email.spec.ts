import { expect, test, type Page } from "@playwright/test";

import {
  APP_ORIGIN,
  hostPageFor,
  openWidget,
  postInboundEmail,
  readInboundEmail,
  registerAccount,
  uniqueAccount,
} from "./helpers";

/** Support-server origin serving the widget host page. Overridable so this
 * spec can run isolated (E2E_SUPPORT_ORIGIN=…) when the default E2E ports
 * are held by another suite run on a shared host. */
const supportOrigin = process.env.E2E_SUPPORT_ORIGIN || "http://localhost:3101";

/**
 * Optional per-Product support email and the mail-loop guard: set in the
 * onboarding Mail step and in Product settings, offered by the widget while
 * Away, refused as a visitor email, and inbound mail from it (or stamped /
 * automatic mail) is ignored instead of becoming a Conversation.
 */
test.describe.serial("product support email", () => {
  const account = uniqueAccount();
  const supportEmail = "support@loopdesk.test";
  let agentPage: Page;
  let productKey = "";
  let productId = "";
  let inboundEmail = "";

  test.beforeAll(async ({ browser }) => {
    agentPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
  });

  test("onboarding Mail step takes the optional support address", async () => {
    await registerAccount(agentPage, account);
    await agentPage.locator("#name").fill(account.workspace);
    await agentPage.getByRole("button", { name: "Continue" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/product/u);
    await agentPage.locator("#name").fill("Loop Desk");
    await agentPage.getByRole("button", { name: "Continue" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/domain/u);
    await agentPage.locator("#domain").fill("loop.desk.test");
    await agentPage.getByRole("button", { name: "Add", exact: true }).click();
    await agentPage.getByRole("button", { name: "Continue" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/mail/u);

    await agentPage.locator("#supportEmail").fill("user@localhost");
    await agentPage.getByRole("button", { name: "Save", exact: true }).click();
    await expect(agentPage.getByText("Enter a valid email address")).toBeVisible();

    await agentPage.locator("#supportEmail").fill(supportEmail);
    await agentPage.getByRole("button", { name: "Save", exact: true }).click();
    await expect(agentPage.getByText("Saved.")).toBeVisible();
    await expect(agentPage.locator("#supportEmail")).toHaveValue(supportEmail);

    await agentPage.getByRole("link", { name: "Skip for now" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/install/u);
    const snippet = (await agentPage.locator("pre").first().textContent()) ?? "";
    productKey = snippet.match(/data-key="(pk_[^"]+)"/u)?.[1] ?? "";
    expect(productKey).toMatch(/^pk_/u);
  });

  test("Product settings → Email shows it and refuses the forwarding address", async () => {
    await agentPage.goto("/settings/products");
    // Scope to the table: a same-named sidebar link (workspace switcher) also
    // matches. Read the href instead of the URL: the detail route cold-compiles
    // on first hit, so the click's navigation may not have landed yet.
    const row = agentPage.getByRole("table").getByRole("link", { name: /Loop Desk/u });
    await expect(row).toBeVisible();
    productId = (await row.getAttribute("href"))?.match(/\/settings\/products\/([^/?]+)/u)?.[1] ?? "";
    expect(productId).not.toBe("");
    await agentPage.goto(`/settings/products/${productId}?tab=email`);
    inboundEmail = await readInboundEmail(agentPage, productId);

    await expect(agentPage.locator("#supportEmail")).toHaveValue(supportEmail);
    await agentPage.locator("#supportEmail").fill(inboundEmail);
    await agentPage.getByRole("button", { name: "Save support address" }).click();
    await expect(agentPage.getByText(/address SupportSeal generated for forwarding/u)).toBeVisible();

    await agentPage.getByText("Advanced: mail loops").click();
    await expect(agentPage.getByText(/never sends mail to this address/u)).toBeVisible();
  });

  test("widget offers the support address while Away and refuses it as a visitor email", async ({ page }) => {
    await agentPage.goto("/inbox");
    const availability = agentPage.getByRole("radiogroup", { name: "Support availability" });
    const away = availability.getByRole("radio", { name: "Away" });
    await away.click();
    await expect(away).toBeChecked();
    // The selection is optimistic; wait until the server change has settled.
    await expect(availability).toHaveAttribute("aria-busy", "false");

    const frame = await openWidget(page, productKey, {
      hostPage: hostPageFor(APP_ORIGIN, supportOrigin),
      status: "Away",
    });
    await expect(frame.locator("#awaySupport")).toContainText(`Write to ${supportEmail}`);
    // Informational, not an error: the muted token, never the danger red the
    // shared .hint rule uses (light-scheme default: --muted #5f6f69).
    await expect(frame.locator("#awaySupport")).toHaveCSS("color", "rgb(95, 111, 105)");

    await frame.locator("#email").fill(supportEmail);
    await frame.locator("#message").fill("Testing as myself.");
    await frame.locator("#awaySend").click();
    await expect(frame.locator("#awayHint")).toContainText("own support address");
    await expect(frame.locator("#awaySend")).toBeEnabled();
  });

  test("inbound mail from the support address, stamped mail and auto-replies are ignored", async () => {
    const base = { to: inboundEmail, subject: "Looping", text: "hello" };
    const own = await postInboundEmail({ ...base, from: supportEmail, headers: { "Message-ID": "<loop-e2e-1@loopdesk.test>" } });
    expect(own).toMatchObject({ status: 200, body: { ignored: true } });

    const stamped = await postInboundEmail({
      ...base,
      from: "sam@customer.test",
      headers: { "Message-ID": "<loop-e2e-2@customer.test>", "X-SupportSeal": inboundEmail.split("@")[1] },
    });
    expect(stamped).toMatchObject({ status: 200, body: { ignored: true } });

    const auto = await postInboundEmail({
      ...base,
      from: "sam@customer.test",
      headers: { "Message-ID": "<loop-e2e-3@customer.test>", Precedence: "auto_reply" },
    });
    expect(auto).toMatchObject({ status: 200, body: { ignored: true } });

    // A genuine customer mail still creates a Conversation.
    const real = await postInboundEmail({
      ...base,
      from: "sam@customer.test",
      subject: "Real question",
      headers: { "Message-ID": "<real-e2e-1@customer.test>", "Auto-Submitted": "no" },
    });
    expect(real.status).toBe(200);
    expect(real.body.ignored).toBeUndefined();
    await agentPage.goto("/inbox");
    const rows = agentPage.locator('ul[aria-label="Conversations"] li a');
    await expect(rows.filter({ hasText: "Real question" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Looping" })).toHaveCount(0);
  });
});
