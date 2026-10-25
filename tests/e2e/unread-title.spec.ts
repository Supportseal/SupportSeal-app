import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { onboardWorkspaceWithProduct, openWidget, uniqueAccount, widgetFrame } from "./helpers";

/**
 * Signed-in title prefix (FR-INBOX-04). Title assertions wait for the count
 * response that backs them. The 99/(99+) boundary is covered in unit tests.
 */
test.describe.serial("unread title prefix", () => {
  const account = uniqueAccount();
  const product = { name: "Unread Beacon", domain: "unread.beacon.test" };

  let agentPage: Page;
  let customerContext: BrowserContext;
  let customerPage: Page;
  let productKey = "";

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();

    customerContext = await browser.newContext();
    customerPage = await customerContext.newPage();
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await customerContext?.close();
  });

  async function visitorSays(text: string) {
    const frame = widgetFrame(customerPage);
    await frame.locator("#input").fill(text);
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText(text, { timeout: 20_000 });
  }

  function waitForOk(page: Page, pathname: string) {
    return page.waitForResponse(
      (response) => new URL(response.url()).pathname === pathname && response.status() === 200,
    );
  }

  test("zero unread shows no prefix on a signed-in page", async () => {
    productKey = await onboardWorkspaceWithProduct(agentPage, account, product);

    const counted = waitForOk(agentPage, "/api/inbox/unread");
    await agentPage.goto("/inbox");
    await expect(agentPage.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
    await counted;
    await expect(agentPage).toHaveTitle(/^Inbox \| /u);
  });

  test("a customer message turns the title into (1); displaying the conversation clears it", async () => {
    await openWidget(customerPage, productKey, { status: "Online" });
    await visitorSays("Hello! The invoice PDF never arrives.");

    await expect(agentPage).toHaveTitle(/^\(1\) Inbox \| /u);

    const marked = waitForOk(agentPage, "/api/inbox/unread/read");
    await agentPage.locator('ul[aria-label="Conversations"] li a').first().click();
    await expect(agentPage).toHaveURL(/\/inbox\/[^/]+\/?$/u);
    await expect(agentPage.getByText(/invoice PDF never arrives/u).first()).toBeVisible();
    await marked;
    await waitForOk(agentPage, "/api/inbox/unread");
    await expect(agentPage).toHaveTitle(/^Conversation \| /u);
  });

  test("a message arriving while the conversation is open is read on display", async () => {
    const marked = waitForOk(agentPage, "/api/inbox/unread/read");
    await visitorSays("It happened again on the billing page.");

    await expect(agentPage.getByText(/happened again on the billing page/u).first()).toBeVisible({
      timeout: 20_000,
    });
    await marked;
    await expect(agentPage).toHaveTitle(/^Conversation \| /u);
    await agentPage.waitForTimeout(1_500);
    await expect(agentPage).toHaveTitle(/^Conversation \| /u);
  });

  test("the prefix survives navigation to another route and reloads; state is persistent", async () => {
    const counted = waitForOk(agentPage, "/api/inbox/unread");
    await agentPage.goto("/inbox");
    await counted;
    await expect(agentPage).toHaveTitle(/^Inbox \| /u);

    await visitorSays("Anyone there? The export is still broken.");
    await expect(agentPage).toHaveTitle(/^\(1\) Inbox \| /u);

    await agentPage.getByRole("link", { name: "Saved replies" }).click();
    await expect(agentPage.getByRole("heading", { name: "Saved replies" })).toBeVisible();
    await expect(agentPage).toHaveTitle(/^\(1\) Saved replies \| /u);

    const reloaded = waitForOk(agentPage, "/api/inbox/unread");
    await agentPage.goto("/inbox");
    await reloaded;
    await expect(agentPage).toHaveTitle(/^\(1\) Inbox \| /u);

    const marked = waitForOk(agentPage, "/api/inbox/unread/read");
    await agentPage.locator('ul[aria-label="Conversations"] li a').first().click();
    await marked;
    await waitForOk(agentPage, "/api/inbox/unread");
    await expect(agentPage).toHaveTitle(/^Conversation \| /u);
  });

  test("a customer reply reopens a closed conversation and counts again", async () => {
    const counted = waitForOk(agentPage, "/api/inbox/unread");
    await agentPage.goto("/inbox");
    await counted;
    await expect(agentPage).toHaveTitle(/^Inbox \| /u);

    await agentPage.locator('ul[aria-label="Conversations"] li a').first().click();
    await expect(agentPage).toHaveURL(/\/inbox\/[^/]+\/?$/u);
    const threadUrl = agentPage.url();
    await agentPage.getByRole("button", { name: "Close", exact: true }).click();
    // The only open conversation: Close advances to the empty state (#199);
    // the closed thread itself has to be revisited to see it Closed.
    await expect(agentPage).toHaveURL(/\/inbox\/?(\?.*)?$/u);
    await agentPage.goto(threadUrl);
    await expect(agentPage.getByRole("button", { name: "Reopen" })).toBeVisible();

    const recount = waitForOk(agentPage, "/api/inbox/unread");
    await agentPage.goto("/inbox");
    await recount;
    await expect(agentPage).toHaveTitle(/^Inbox \| /u);

    await visitorSays("It is back: the export broke again overnight.");
    await expect(agentPage).toHaveTitle(/^\(1\) Inbox \| /u);

    const marked = waitForOk(agentPage, "/api/inbox/unread/read");
    await agentPage.locator('ul[aria-label="Conversations"] li a').first().click();
    await marked;
    await waitForOk(agentPage, "/api/inbox/unread");
    await expect(agentPage).toHaveTitle(/^Conversation \| /u);
  });

  test("signing out leaves a prefix-free title behind", async () => {
    await agentPage.goto("/inbox");
    await expect(agentPage).toHaveTitle(/^Inbox \| /u);
    await visitorSays("One more before you go: the CSV export hangs.");
    await expect(agentPage).toHaveTitle(/^\(1\) Inbox \| /u);

    await agentPage.getByRole("button", { name: "Account menu" }).click();
    await agentPage.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(agentPage).toHaveURL(/\/login/u);
    await expect(agentPage).toHaveTitle(/^Sign in \| /u);
    await expect(agentPage).not.toHaveTitle(/\(\d/u);
  });
});
