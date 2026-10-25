import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { loadFixtures, openWidget, registerAccount, signIn, uniqueAccount } from "./helpers";

/**
 * Cross-Workspace isolation sanity (docs/FRD.md, FR-SEC-01): an agent of a
 * different Workspace must not reach Workspace Beta's conversations, product,
 * search results or attachments through URLs, APIs or the widget — even with
 * valid-looking IDs. The Beta fixture workspace and a real conversation with
 * an attachment are created first, and the Beta owner acts as the positive
 * control.
 */
test.describe.serial("cross-Workspace isolation", () => {
  const attacker = uniqueAccount();

  let attackerPage: Page;
  let betaOwnerPage: Page;
  let betaCustomerContext: BrowserContext;
  let betaConversationId = "";
  let betaAttachmentId = "";

  test.beforeAll(async ({ browser }) => {
    const fixtures = loadFixtures();
    betaOwnerPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await signIn(betaOwnerPage, fixtures.beta.owner.email, fixtures.beta.owner.password);

    const attackerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    attackerPage = await attackerContext.newPage();

    betaCustomerContext = await browser.newContext();
  });

  test.afterAll(async () => {
    await betaOwnerPage?.context().close();
    await attackerPage?.context().close();
    await betaCustomerContext?.close();
  });

  test("a visitor creates a real Beta conversation with an attachment", async () => {
    const fixtures = loadFixtures();
    const page = await betaCustomerContext.newPage();
    const frame = await openWidget(page, fixtures.beta.product.key, {
      status: "Online",
    });
    await frame.locator("#fileInput").setInputFiles({
      name: "beta-invoice.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Beta customer invoice data"),
    });
    await frame.locator("#input").fill("Question about my Beta Tool invoice.");
    await frame.locator("#send").click();

    await expect(frame.getByText("beta-invoice.txt").first()).toBeVisible();
    const attachmentHref = await frame
      .getByRole("link", { name: /beta-invoice\.txt/u })
      .first()
      .getAttribute("href");
    betaAttachmentId = attachmentHref?.match(/\/api\/attachments\/([^/?]+)/u)?.[1] ?? "";
    expect(betaAttachmentId).not.toBe("");
    await page.close();
  });

  test("the Beta owner sees the conversation and attachment (positive control)", async () => {
    await betaOwnerPage.goto("/inbox");
    const row = betaOwnerPage
      .locator('ul[aria-label="Conversations"] li a')
      .filter({ hasText: "Beta Tool invoice" })
      .first();
    await expect(row).toBeVisible();
    const href = (await row.getAttribute("href")) ?? "";
    betaConversationId = href.match(/\/inbox\/([^/?]+)/u)?.[1] ?? "";
    expect(betaConversationId).not.toBe("");
    await row.click();
    await expect(betaOwnerPage.getByText("Beta Tool invoice").first()).toBeVisible();
    await expect(
      betaOwnerPage.getByRole("link", { name: /beta-invoice\.txt/u }).first(),
    ).toBeVisible();
    await betaOwnerPage.context().close();
  });

  test("attacker registers a second Workspace", async () => {
    await registerAccount(attackerPage, attacker);
    await attackerPage.locator("#name").fill(attacker.workspace);
    await attackerPage.getByRole("button", { name: "Continue" }).click();
    await expect(attackerPage).toHaveURL(/\/onboarding\/product/u);
  });

  test("conversation URL from another Workspace 404s", async () => {
    const response = await attackerPage.goto(`/inbox/${betaConversationId}`);
    expect(response?.status()).toBe(404);
  });

  test("product URL from another Workspace 404s", async () => {
    const fixtures = loadFixtures();
    const response = await attackerPage.goto(`/settings/products/${fixtures.beta.product.id}`);
    expect(response?.status()).toBe(404);
  });

  test("inbox API never returns another Workspace's conversations", async () => {
    const fixtures = loadFixtures();
    const byProduct = await attackerPage.request.get(
      `/api/inbox?status=ALL&product=${fixtures.beta.product.id}`,
    );
    expect(byProduct.status()).toBe(200);
    expect(await byProduct.json()).toMatchObject({ items: [] });

    const bySearch = await attackerPage.request.get(
      `/api/inbox?status=ALL&q=${encodeURIComponent("Beta Tool invoice")}`,
    );
    expect(await bySearch.json()).toMatchObject({ items: [] });
  });

  test("attachment URL from another Workspace is refused", async () => {
    const response = await attackerPage.request.get(`/api/attachments/${betaAttachmentId}`);
    expect([401, 403, 404]).toContain(response.status());
  });

  test("a foreign visitor session cannot read Beta's conversation", async () => {
    const fixtures = loadFixtures();
    const session = await attackerPage.request.post(
      `/api/widget/session?key=${encodeURIComponent(fixtures.beta.product.key)}&host=${encodeURIComponent("http://localhost:3101")}`,
    );
    expect(session.status()).toBe(200);
    const { token } = (await session.json()) as { token?: string };
    expect(token).toBeTruthy();

    const thread = await attackerPage.request.get(
      `/api/widget/messages?key=${encodeURIComponent(fixtures.beta.product.key)}&host=${encodeURIComponent("http://localhost:3101")}`,
      { headers: { "x-ss-visitor-token": token! } },
    );
    expect(thread.status()).toBe(200);
    const body = (await thread.json()) as { thread: { conversationId: string | null; messages: unknown[] } };
    expect(body.thread.conversationId).toBeNull();
    expect(body.thread.messages).toHaveLength(0);
  });

  test("inbound email webhook rejects callers without the shared secret", async () => {
    const response = await attackerPage.request.post("/api/email/inbound", {
      data: { from: "someone@evil.test", to: "support@beta.test", subject: "spoof", text: "hi" },
    });
    expect(response.status()).toBe(401);
  });
});
