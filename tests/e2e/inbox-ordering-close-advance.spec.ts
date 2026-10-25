import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { onboardWorkspaceWithProduct, openWidget, uniqueAccount } from "./helpers";

/**
 * Inbox ordering and close-advance (#199): every tab lists conversations
 * oldest first, and closing the thread that is open advances to the next
 * conversation in that order — the empty state once the closed one was last.
 * Works the same on the desk (thread beside the list) and on a phone (list
 * and thread as separate screens).
 */
test.describe.serial("inbox is oldest-first and Close advances", () => {
  const account = uniqueAccount();
  const product = { name: "Auto Advance", domain: "advance.tickets.test" };
  const messages = ["First question: invoices", "Second question: exports", "Third question: SSO"];

  let agentPage: Page;
  const visitorPages: Page[] = [];
  const visitorContexts: BrowserContext[] = [];
  let productKey = "";

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();
    // First visit compiles the route under next dev; let it hydrate before the form is used.
    await agentPage.goto("/register", { waitUntil: "networkidle" });
    productKey = await onboardWorkspaceWithProduct(agentPage, account, product);

    // One visitor per conversation, sent oldest first, so with the list
    // ordered by creation the oldest ticket is the first row.
    for (const message of messages) {
      const context = await browser.newContext();
      visitorContexts.push(context);
      const page = await context.newPage();
      visitorPages.push(page);
      const frame = await openWidget(page, productKey, { status: "Online" });
      await frame.locator("#input").fill(message);
      await frame.locator("#send").click();
      await expect(frame.locator("#thread")).toContainText(message);
    }
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await Promise.all(visitorContexts.map((context) => context.close()));
  });

  const row = (page: Page, text: string) =>
    page.getByRole("list", { name: "Conversations" }).getByRole("link", { name: new RegExp(text, "u") });
  const close = (page: Page) => page.getByRole("button", { name: "Close", exact: true }).click();

  test("desktop: Close works the list top-down and ends on the empty state", async () => {
    await agentPage.goto("/inbox");
    await expect(row(agentPage, messages[0])).toBeVisible({ timeout: 20_000 });
    await expect(row(agentPage, messages[2])).toBeVisible();

    // Oldest first: the first row of the list is the oldest ticket.
    const links = agentPage.getByRole("list", { name: "Conversations" }).getByRole("link");
    await expect(links.first()).toContainText(messages[0]);
    await expect(links.last()).toContainText(messages[2]);
    const firstHref = await row(agentPage, messages[0]).getAttribute("href");
    const secondHref = await row(agentPage, messages[1]).getAttribute("href");
    const thirdHref = await row(agentPage, messages[2]).getAttribute("href");
    expect(firstHref).toBeTruthy();
    expect(secondHref).toBeTruthy();
    expect(thirdHref).toBeTruthy();

    await row(agentPage, messages[0]).click();
    await expect(agentPage).toHaveURL(new RegExp(`${firstHref}$`, "u"));

    await close(agentPage);
    await expect(agentPage).toHaveURL(new RegExp(`${secondHref}$`, "u"));
    await close(agentPage);
    await expect(agentPage).toHaveURL(new RegExp(`${thirdHref}$`, "u"));
    await close(agentPage);
    // The last one closed: nothing left to advance to, so the empty state.
    await expect(agentPage).toHaveURL(/\/inbox\/?(\?.*)?$/u);
    await expect(agentPage.getByText("Select a conversation")).toBeVisible();
    await expect(agentPage.getByText("No open conversations.")).toBeVisible();
  });

  test("mobile: Close opens the next open conversation, then returns to the list", async () => {
    // Two visitors follow up, reopening their closed conversations (a
    // customer reply reopens a Closed conversation) in creation order.
    const followUps = ["Follow-up: exports still failing", "Follow-up: SSO is working now"];
    for (const [offset, followUp] of followUps.entries()) {
      const frame = await openWidget(visitorPages[offset + 1], productKey, { status: "Online" });
      await frame.locator("#input").fill(followUp);
      await frame.locator("#send").click();
      await expect(frame.locator("#thread")).toContainText(followUp);
    }

    await agentPage.setViewportSize({ width: 390, height: 844 });
    await agentPage.goto("/inbox");
    await expect(row(agentPage, followUps[0])).toBeVisible({ timeout: 20_000 });
    await expect(row(agentPage, followUps[1])).toBeVisible();
    const secondHref = await row(agentPage, followUps[0]).getAttribute("href");
    const thirdHref = await row(agentPage, followUps[1]).getAttribute("href");
    expect(secondHref).toBeTruthy();
    expect(thirdHref).toBeTruthy();

    await row(agentPage, followUps[0]).click();
    await expect(agentPage).toHaveURL(new RegExp(`${secondHref}$`, "u"));
    await close(agentPage);
    // Advanced to the next open conversation, still on the thread screen.
    await expect(agentPage).toHaveURL(new RegExp(`${thirdHref}$`, "u"));
    await expect(agentPage.getByRole("button", { name: "Back to inbox" })).toBeVisible();
    await expect(agentPage.getByRole("button", { name: "Close", exact: true })).toBeVisible();

    await close(agentPage);
    // Nothing left to advance to: back on the list.
    await expect(agentPage).toHaveURL(/\/inbox\/?(\?.*)?$/u);
    await expect(agentPage.getByText("No open conversations.")).toBeVisible();
  });
});
