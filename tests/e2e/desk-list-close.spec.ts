import { expect, test, type Browser, type Page } from "@playwright/test";

import { HOST_PAGE, onboardWorkspaceWithProduct, uniqueAccount, widgetFrame } from "./helpers";

/**
 * Each Open/Pending row has a close button so an agent can close a thread
 * without opening it: it never navigates, updates the list and the tab counts
 * at once, and is reachable on a phone-width screen where there is no hover.
 */
test.describe.serial("close a conversation from the list", () => {
  const account = uniqueAccount();
  const product = { name: "List Close", domain: "close.tickets.test" };

  let agentPage: Page;
  let productKey = "";

  async function customerSends(browser: Browser, message: string) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${HOST_PAGE}&key=${encodeURIComponent(productKey)}`);
      await page.locator("#supportseal-widget-host button").first().click();
      const frame = widgetFrame(page);
      await expect(frame.locator("#statusline")).toContainText("Online");
      await frame.locator("#input").fill(message);
      await frame.locator("#send").click();
      await expect(frame.getByText(message)).toBeVisible();
    } finally {
      await context.close();
    }
  }

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();
    productKey = await onboardWorkspaceWithProduct(agentPage, account, product);
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
  });

  test("closing from the row stays on the list and files the thread under Closed", async ({ browser }) => {
    test.setTimeout(120_000);
    await customerSends(browser, "Please close me from the list");
    await agentPage.goto("/inbox");
    const list = agentPage.getByRole("list", { name: "Conversations" });
    await expect(list.getByText("Please close me from the list")).toBeVisible({ timeout: 20_000 });

    await list.getByRole("button", { name: /^Close conversation with / }).click();

    await expect(list.getByText("Please close me from the list")).toHaveCount(0);
    await expect(agentPage).toHaveURL(/\/inbox(\?|$)/);
    const closedTab = agentPage.getByRole("tab", { name: /Closed/ });
    await expect(closedTab).toContainText("1");

    await closedTab.click();
    await expect(list.getByText("Please close me from the list")).toBeVisible();
    // Already closed: nothing left to close.
    await expect(list.getByRole("button", { name: /^Close conversation with / })).toHaveCount(0);
  });

  test("the button is visible and tappable on a phone-width screen", async ({ browser }) => {
    test.setTimeout(120_000);
    await customerSends(browser, "Close me from my phone");
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      storageState: await agentPage.context().storageState(),
    });
    try {
      const page = await phone.newPage();
      await page.goto("/inbox");
      const list = page.getByRole("list", { name: "Conversations" });
      await expect(list.getByText("Close me from my phone")).toBeVisible({ timeout: 20_000 });
      const button = list.getByRole("button", { name: /^Close conversation with / });
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(32);
      expect(box?.height).toBeGreaterThanOrEqual(32);

      await button.tap();

      await expect(list.getByText("Close me from my phone")).toHaveCount(0);
      await expect(page).toHaveURL(/\/inbox(\?|$)/);
    } finally {
      await phone.close();
    }
  });
});
