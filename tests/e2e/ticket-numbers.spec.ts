import { expect, test, type Page } from "@playwright/test";

import {
  INBOUND_SECRET,
  APP_ORIGIN,
  onboardWorkspaceWithProduct,
  openWidget,
  readInboundEmail,
  uniqueAccount,
} from "./helpers";

/**
 * Ticket numbers (issue #141): concurrent creations through every intake
 * path (widget chats and inbound email, in one Workspace) must receive
 * distinct, never-reused, gap-free numbers.
 */
test.describe.serial("ticket number allocation under concurrency", () => {
  const account = uniqueAccount();
  let agentPage: Page;
  let productKey = "";
  let inboundEmail = "";

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await context.newPage();
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
  });

  test("onboard a Workspace and Product", async () => {
    productKey = await onboardWorkspaceWithProduct(agentPage, account, {
      name: "Race Desk",
      domain: "race.desk.test",
    });
    await agentPage.goto("/settings/products");
    const href = await agentPage.locator('a[href^="/settings/products/"]').first().getAttribute("href");
    const productId = href?.split("/").filter(Boolean).at(-1) ?? "";
    expect(productId).not.toBe("");
    inboundEmail = await readInboundEmail(agentPage, productId);
  });

  test("simultaneous widget chats and inbound emails never share a number", async ({ browser }) => {
    test.setTimeout(150_000);
    const chats = 4;
    const emails = 8;

    const contexts = await Promise.all(Array.from({ length: chats }, () => browser.newContext()));
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const frames = await Promise.all(pages.map((page) => openWidget(page, productKey, { status: "Online" })));

    await Promise.all([
      ...frames.map(async (frame, index) => {
        await frame.locator("#input").fill(`Concurrent chat ${index}`);
        await frame.locator("#send").click();
        await expect(frame.locator("#ticketRef")).toHaveText(/^Reference SS-\d+$/u);
      }),
      ...Array.from({ length: emails }, async (_, index) => {
        const response = await fetch(`${APP_ORIGIN}/api/email/inbound`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-supportseal-inbound-secret": INBOUND_SECRET },
          body: JSON.stringify({
            from: `racer${index}@customer.test`,
            to: inboundEmail,
            subject: `Concurrent email ${index}`,
            text: `Email body ${index}`,
            headers: { "Message-ID": `<race-${account.email}-${index}@mailer.test>` },
          }),
        });
        expect(response.status).toBe(200);
      }),
    ]);

    // Numbers shown to the customers...
    const widgetRefs = await Promise.all(
      frames.map(async (frame) => ((await frame.locator("#ticketRef").innerText()).replace("Reference ", "")).trim()),
    );
    for (const context of contexts) await context.close();

    // ...and in the desk list.
    const items = await agentPage.evaluate(async () => {
      const response = await fetch("/api/inbox?status=OPEN");
      return ((await response.json()) as { items: Array<{ ticketNumber: number }> }).items;
    });
    const numbers = items.map((item) => item.ticketNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: chats + emails }, (_, index) => index + 1));
    expect(new Set(widgetRefs).size).toBe(chats);
    for (const ref of widgetRefs) expect(numbers).toContain(Number(ref.replace("SS-", "")));
  });
});
