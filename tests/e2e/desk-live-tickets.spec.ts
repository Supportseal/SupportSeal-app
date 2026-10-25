import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { HOST_PAGE, onboardWorkspaceWithProduct, uniqueAccount, widgetFrame } from "./helpers";

/**
 * The agent's ticket list updates in place (#115): a signed-in agent sitting
 * on /inbox sees a visitor's new conversation arrive without a reload, and
 * later activity (a follow-up message, a status change) re-sorts and
 * re-files the row live.
 */
test.describe.serial("desk ticket list is live", () => {
  const account = uniqueAccount();
  const product = { name: "Live Tickets", domain: "live.tickets.test" };

  let agentPage: Page;
  let customerContext: BrowserContext;
  let customerPage: Page;
  let productKey = "";

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

  test("a new conversation appears in the open list without a reload", async () => {
    // First visit compiles the widget and inbox routes under next dev.
    test.setTimeout(120_000);
    await agentPage.goto("/inbox");
    await expect(agentPage.getByText("No open conversations.")).toBeVisible();
    // A marker that only survives while the document is never reloaded.
    await agentPage.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });

    await customerPage.goto(`${HOST_PAGE}&key=${encodeURIComponent(productKey)}`);
    await customerPage.locator("#supportseal-widget-host button").first().click();
    const frame = widgetFrame(customerPage);
    await expect(frame.locator("#statusline")).toContainText("Online");
    await frame.locator("#input").fill("Where do I find my invoices?");
    await frame.locator("#send").click();

    const list = agentPage.getByRole("list", { name: "Conversations" });
    await expect(list.getByText("Where do I find my invoices?")).toBeVisible({ timeout: 20_000 });
    expect(
      await agentPage.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true);
  });

  test("a follow-up message updates the row preview in place", async () => {
    const frame = widgetFrame(customerPage);
    await frame.locator("#input").fill("Never mind, found them under Billing.");
    await frame.locator("#send").click();

    const list = agentPage.getByRole("list", { name: "Conversations" });
    await expect(list.getByText("Never mind, found them under Billing.")).toBeVisible({
      timeout: 20_000,
    });
  });
  test("live refresh preserves loaded pages and supersedes a delayed Load more", async () => {
    const tickets = Array.from({ length: 65 }, (_, index) => ({
      id: `pagination-${index}`,
      status: "OPEN",
      channel: "CHAT",
      subject: `Pagination ticket ${index}`,
      lastMessageAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
      product: { id: "pagination-product", name: product.name, primaryColor: "#3366ff" },
      contact: { id: `contact-${index}`, name: `Customer ${index}`, email: null },
      preview: "Pagination regression",
      tags: [],
    }));
    let rows = [...tickets];
    let holdNextPage = false;
    let releasePage!: () => void;
    let pageStarted!: () => void;
    let pageFinished!: () => void;
    const started = new Promise<void>((resolve) => { pageStarted = resolve; });
    const held = new Promise<void>((resolve) => { releasePage = resolve; });
    const finished = new Promise<void>((resolve) => { pageFinished = resolve; });
    await agentPage.route("**/api/inbox?*", async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
      const items = rows.slice(start, start + 30);
      const body = {
        items,
        nextCursor: start + 30 < rows.length ? items.at(-1)!.id : null,
        statusCounts: { OPEN: rows.length, PENDING: 0, CLOSED: 0 },
      };
      const delayed = holdNextPage && Boolean(cursor);
      if (delayed) {
        holdNextPage = false;
        pageStarted();
        await held;
      }
      // Aborted requests can still be fulfilled by the routing harness;
      // client-side ownership must prevent them changing the list.
      await route.fulfill({ json: body });
      if (delayed) pageFinished();
    });
    try {
      await agentPage.goto("/inbox");
      const list = agentPage.getByRole("list", { name: "Conversations" });
      await expect(list.getByRole("link")).toHaveCount(30);
      await agentPage.getByRole("button", { name: "Load more", exact: true }).click();
      await expect(list.getByRole("link")).toHaveCount(60);

      holdNextPage = true;
      await agentPage.getByRole("button", { name: "Load more", exact: true }).click();
      await started;
      const cancelled = agentPage.waitForEvent("requestfailed", (request) =>
        request.url().includes("/api/inbox?") &&
        new URL(request.url()).searchParams.get("cursor") === tickets[59].id,
      );
      rows = [{ ...tickets[0], id: "pagination-new", subject: "Live arrival", lastMessageAt: new Date().toISOString() }, ...tickets];
      const frame = widgetFrame(customerPage);
      await frame.locator("#input").fill("Trigger the pagination refresh.");
      await frame.locator("#send").click();
      await expect(list.getByText("Live arrival", { exact: true })).toBeVisible();
      await expect(list.getByRole("link")).toHaveCount(66);
      await expect(list.getByText("Pagination ticket 59", { exact: true })).toBeAttached();
      releasePage();
      await finished;
      await cancelled;
      await expect(list.getByRole("link")).toHaveCount(66);
      const hrefs = await list.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
      expect(new Set(hrefs).size).toBe(hrefs.length);
    } finally {
      releasePage();
      await agentPage.unroute("**/api/inbox?*");
    }
  });

});
