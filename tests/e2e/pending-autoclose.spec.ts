import { expect, test, type Page } from "@playwright/test";

import { loadFixtures, signIn } from "./helpers";

test.describe.serial("stale PENDING conversation auto-closes", () => {
  let agentPage: Page;

  test.beforeAll(async ({ browser }) => {
    const fixtures = loadFixtures();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await context.newPage();
    await signIn(agentPage, fixtures.gamma.owner.email, fixtures.gamma.owner.password);
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
  });

  test("the row is filed under Closed with the internal auto-close note", async () => {
    test.setTimeout(240_000);
    const { conversation } = loadFixtures().gamma;
    const closedTab = agentPage.getByRole("tab", { name: /Closed/ });
    await expect(async () => {
      await agentPage.goto("/inbox");
      await expect(closedTab).toContainText("1", { timeout: 5_000 });
    }).toPass({ timeout: 180_000, intervals: [2_000, 5_000, 10_000] });
    await closedTab.click();
    const list = agentPage.getByRole("list", { name: "Conversations" });
    const row = list.getByRole("link").filter({ hasText: conversation.subject }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(/closed/iu);
    await expect(row).toContainText(conversation.ticketRef);
    await row.click();

    await expect(agentPage).toHaveURL(new RegExp(`/inbox/${conversation.id}(/|\\?|$)`, "u"));
    await expect(agentPage.getByRole("button", { name: "Reopen" })).toBeVisible();
    const notes = agentPage.locator('article[aria-label="Internal note by agent"]');
    await expect(notes).toHaveCount(1);
    await expect(notes.first()).toContainText("Auto-closed after 5 days of inactivity");
    await expect(agentPage.getByText(conversation.ticketRef).first()).toBeVisible();

    await agentPage.goto("/inbox");
    await agentPage.getByRole("tab", { name: /Pending/ }).click();
    await expect(list.getByText(conversation.subject)).toHaveCount(0);
  });
});
