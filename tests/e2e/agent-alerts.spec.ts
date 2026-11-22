import { expect, test, type Page } from "@playwright/test";

import {
  onboardWorkspaceWithProduct,
  openWidget,
  resetCapturedEmails,
  uniqueAccount,
  waitForEmail,
} from "./helpers";

/**
 * New-message email alerts (FR-ALERT-01, docs/design/agent-alerts.md): with
 * no dashboard open, a new chat that is still unanswered after 2 minutes is
 * emailed to the member; Settings → Notifications holds each member's own
 * choices and persists them.
 */
test.describe.serial("agent new-message email alerts", () => {
  const account = uniqueAccount();
  let agentPage: Page;
  let productKey = "";

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await context.newPage();
    productKey = await onboardWorkspaceWithProduct(agentPage, account, {
      name: "Alert Desk",
      domain: "alerts.desk.test",
    });
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
  });

  test("a new chat is emailed to the member while no dashboard is open", async ({ page }) => {
    test.setTimeout(240_000);
    // Leave the dashboard: its inbox stream is what marks a member as present.
    await agentPage.goto("about:blank");
    await resetCapturedEmails();

    const frame = await openWidget(page, productKey, { status: "Online" });
    await frame.locator("#input").fill("Hello! My CSV export is empty.");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("CSV export is empty");

    const alert = await waitForEmail(
      (email) => email.to.includes(account.email) && email.subject.includes("[Alert Desk] New:"),
      200_000,
    );
    expect(alert.subject).toMatch(/^\[Alert Desk\] New: Hello! My CSV export is empty\. \(SS-\d+\)$/u);
    expect(alert.body).toContain("Hello! My CSV export is empty.");
    expect(alert.body).toMatch(/\/inbox\/[0-9a-f-]{36}/u);
    expect(alert.body).toContain("/settings/notifications");
  });

  test("each member turns their own alerts on and off in Settings", async () => {
    await agentPage.goto("/settings/notifications");
    await expect(agentPage.getByRole("heading", { name: "Email alerts" })).toBeVisible();
    await expect(agentPage.getByText(account.email)).toBeVisible();
    const newConversations = agentPage.getByRole("switch", { name: "New conversations" });
    const replies = agentPage.getByRole("switch", { name: "Customer replies" });
    await expect(newConversations).toHaveAttribute("data-state", "checked");
    await expect(replies).toHaveAttribute("data-state", "checked");

    await replies.click();
    await agentPage.getByRole("button", { name: "Save" }).click();
    await expect(agentPage.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    // The switch keeps the saved choice after the save (no snap back).
    await expect(replies).toHaveAttribute("data-state", "unchecked");

    await agentPage.reload();
    await expect(replies).toHaveAttribute("data-state", "unchecked");
    await expect(newConversations).toHaveAttribute("data-state", "checked");
    await expect(agentPage.getByRole("link", { name: "Notifications" })).toHaveAttribute("aria-current", "page");
  });
});
