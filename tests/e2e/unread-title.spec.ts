import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { onboardWorkspaceWithProduct, openWidget, uniqueAccount, widgetFrame } from "./helpers";

/**
 * Signed-in title prefix (FR-INBOX-04): the number of OPEN Conversations in
 * the Workspace — the same count as the inbox Open tab — kept live from the
 * inbox event stream. The 99/(99+) boundary is covered in unit tests.
 */
test.describe.serial("open-conversations title prefix", () => {
  const account = uniqueAccount();
  const product = { name: "Unread Beacon", domain: "unread.beacon.test" };

  let agentPage: Page;
  let visitorOne: { context: BrowserContext; page: Page };
  let visitorTwo: { context: BrowserContext; page: Page };
  let productKey = "";

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();

    const contextOne = await browser.newContext();
    visitorOne = { context: contextOne, page: await contextOne.newPage() };
    const contextTwo = await browser.newContext();
    visitorTwo = { context: contextTwo, page: await contextTwo.newPage() };
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await visitorOne?.context.close();
    await visitorTwo?.context.close();
  });

  async function visitorSays(page: Page, text: string) {
    const frame = widgetFrame(page);
    await frame.locator("#input").fill(text);
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText(text, { timeout: 20_000 });
  }

  const row = (text: string) =>
    agentPage.getByRole("list", { name: "Conversations" }).getByRole("link", { name: new RegExp(text, "u") });

  test("no open conversations shows no prefix on a signed-in page", async () => {
    productKey = await onboardWorkspaceWithProduct(agentPage, account, product);
    await agentPage.goto("/inbox");
    await expect(agentPage.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
    await expect(agentPage).toHaveTitle(/^Inbox \| /u);
  });

  test("a new widget conversation bumps the title live and the number matches the Open tab", async () => {
    await openWidget(visitorOne.page, productKey, { status: "Online" });
    await visitorSays(visitorOne.page, "Hello! The invoice PDF never arrives.");

    // No reload: the inbox event stream refreshes the count.
    await expect(agentPage).toHaveTitle(/^\(1\) Inbox \| /u);
    await expect(agentPage.getByRole("tab", { name: /^Open\s*1$/u })).toBeVisible({ timeout: 20_000 });
  });

  test("reading a conversation does not clear the count (it is open, not unread)", async () => {
    await row("invoice PDF never arrives").click();
    await expect(agentPage).toHaveURL(/\/inbox\/[^/]+\/?$/u);
    await expect(agentPage.getByText(/invoice PDF never arrives/u).first()).toBeVisible();
    await agentPage.waitForTimeout(1_500);
    await expect(agentPage).toHaveTitle(/^\(1\) Conversation \| /u);
  });

  test("another conversation bumps the title on a page without the inbox list", async () => {
    await agentPage.getByRole("link", { name: "Saved replies" }).click();
    await expect(agentPage.getByRole("heading", { name: "Saved replies" })).toBeVisible();
    await expect(agentPage).toHaveTitle(/^\(1\) Saved replies \| /u);

    await openWidget(visitorTwo.page, productKey, { status: "Online" });
    await visitorSays(visitorTwo.page, "Second customer: the export hangs.");
    await expect(agentPage).toHaveTitle(/^\(2\) Saved replies \| /u);
  });

  test("closing a conversation drops the count", async () => {
    await agentPage.goto("/inbox");
    await expect(agentPage).toHaveTitle(/^\(2\) Inbox \| /u);
    await row("invoice PDF never arrives").click();
    await agentPage.getByRole("button", { name: "Close", exact: true }).click();
    await expect(agentPage).toHaveTitle(/^\(1\) /u);
    await agentPage.goto("/inbox");
    await expect(agentPage).toHaveTitle(/^\(1\) Inbox \| /u);
    await expect(agentPage.getByRole("tab", { name: /^Open\s*1$/u })).toBeVisible();
  });

  test("a customer reply moves a Pending conversation back to Open and counts again", async () => {
    await row("export hangs").click();
    await agentPage.getByLabel(/^Reply to /u).fill("Which export are you running?");
    await agentPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(agentPage.locator("header").getByText("Pending").first()).toBeVisible();
    // Pending is awaiting the customer, so it no longer counts as open.
    await expect(agentPage).toHaveTitle(/^Conversation \| /u);

    await visitorSays(visitorTwo.page, "The CSV one, it stalls at 10%.");
    await expect(agentPage.locator("header").getByText("Open").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(agentPage).toHaveTitle(/^\(1\) Conversation \| /u);
  });

  test("a customer reply reopens a closed conversation and counts again", async () => {
    await agentPage.goto("/inbox");
    await expect(agentPage).toHaveTitle(/^\(1\) Inbox \| /u);
    await visitorSays(visitorOne.page, "It is back: the PDF broke again overnight.");
    await expect(agentPage).toHaveTitle(/^\(2\) Inbox \| /u);
  });

  test("signing out leaves a prefix-free title behind", async () => {
    await agentPage.getByRole("button", { name: "Account menu" }).click();
    await agentPage.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(agentPage).toHaveURL(/\/login/u);
    await expect(agentPage).toHaveTitle(/^Sign in \| /u);
    await expect(agentPage).not.toHaveTitle(/\(\d/u);
  });
});
