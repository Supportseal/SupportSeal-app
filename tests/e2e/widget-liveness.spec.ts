import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { HOST_PAGE, onboardWorkspaceWithProduct, uniqueAccount, widgetFrame } from "./helpers";

/**
 * Realtime both ways between an open widget and an open desk view:
 * - the panel learns it is visible even when the launcher click beat the
 *   panel document's load (the loader's ss:open used to be dropped there,
 *   leaving every later agent reply unrendered until a reload);
 * - replies that arrive while the panel is closed render on reopen;
 * - an email the visitor adds mid-chat reaches the open conversation view
 *   without a reload.
 */
test.describe.serial("widget and desk liveness", () => {
  const account = uniqueAccount();
  const product = { name: "Liveness Desk", domain: "liveness.desk.test" };

  let agentPage: Page;
  let customerContext: BrowserContext;
  let customerPage: Page;
  let productKey = "";
  let conversationId = "";

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();
    customerContext = await browser.newContext();
    customerPage = await customerContext.newPage();
    productKey = await onboardWorkspaceWithProduct(agentPage, account, product);
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await customerContext?.close();
  });

  async function agentReply(text: string) {
    const send = agentPage.getByRole("button", { name: "Send", exact: true });
    // A fill that lands before hydration never reaches React state; refill
    // until the composer is live.
    await expect(async () => {
      await agentPage.getByLabel(/^Reply to /u).fill(text);
      await expect(send).toBeEnabled({ timeout: 1000 });
    }).toPass();
    await send.click();
    await expect(agentPage.getByRole("article").filter({ hasText: text }).first()).toBeVisible();
  }

  test("a launcher click before the panel loads still renders agent replies", async () => {
    // First visit compiles the widget, inbox and reply routes under next dev.
    test.setTimeout(120_000);
    // Hold the panel document so the click deterministically lands first.
    await customerPage.route(
      (url) => url.pathname === "/widget",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      },
    );
    await customerPage.goto(`${HOST_PAGE}&key=${encodeURIComponent(productKey)}`);
    const launcher = customerPage.locator("#supportseal-widget-host button").first();
    await launcher.click();
    const frame = widgetFrame(customerPage);
    await expect(frame.locator("#statusline")).toContainText("Online");

    const sent = customerPage.waitForResponse(
      (r) => r.url().includes("/api/widget/messages") && r.request().method() === "POST",
    );
    await frame.locator("#input").fill("Is CSV export available on the Starter plan?");
    await frame.locator("#send").click();
    conversationId = ((await (await sent).json()) as { thread: { conversationId: string } }).thread
      .conversationId;

    await agentPage.goto(`/inbox/${conversationId}`);
    await agentReply("Yes, CSV export is on every plan.");
    await expect(frame.locator(".msg.agent")).toContainText("CSV export is on every plan", {
      timeout: 20_000,
    });
  });

  test("replies that arrive while the panel is closed render on reopen", async () => {
    const launcher = customerPage.locator("#supportseal-widget-host button").first();
    await launcher.click();
    await agentReply("One more thing: exports run nightly.");
    await expect(launcher.locator(".badge")).toBeVisible({ timeout: 20_000 });

    await launcher.click();
    await expect(widgetFrame(customerPage).locator(".msg.agent").last()).toContainText(
      "exports run nightly",
    );
  });

  test("an email added mid-chat reaches the open conversation without a reload", async () => {
    await expect(agentPage.getByText("Anonymous visitor")).toBeVisible();
    const frame = widgetFrame(customerPage);
    await frame.locator("#captureEmail").fill("dana.kim@example.org");
    await frame.locator("#captureSave").click();
    await expect(frame.locator("#thread")).toContainText("dana.kim@example.org");

    await expect(agentPage.getByText("dana.kim@example.org").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(agentPage).toHaveURL(new RegExp(`/inbox/${conversationId}`, "u"));
  });
});
