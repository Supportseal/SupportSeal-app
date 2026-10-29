import { expect, test, type Page } from "@playwright/test";

import { loadFixtures, signIn, widgetFrame } from "./helpers";

/**
 * The dashboard's own support chat (SUPPORT_WIDGET_KEY, set by bootstrap.mjs
 * to the seeded "Operator Help" Product): shown on sign-in and settings
 * pages, kept off the inbox and out of the way of dialogs, and never handing
 * one dashboard user's support thread to the next person on the device.
 */
test.describe.serial("own support widget in the dashboard", () => {
  const fixtures = loadFixtures();
  const owner = fixtures.beta.owner;
  const launcher = (page: Page) => page.locator("#supportseal-widget-host button.launcher");

  test("sign-in, settings and dialogs: visible where it fits, hidden where it would cover controls", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(launcher(page)).toBeVisible();

    await signIn(page, owner.email, owner.password);
    // The inbox never shows it (the launcher would cover the reply box).
    await expect(launcher(page)).toBeHidden();

    await page.goto("/settings");
    await expect(launcher(page)).toBeVisible();

    // Client navigation keeps the loader in the document; it must hide.
    await page.getByRole("link", { name: "Inbox" }).first().click();
    await expect(page).toHaveURL(/\/inbox/u);
    await expect(launcher(page)).toBeHidden();

    // Open dialogs hide it so footer buttons stay reachable.
    await page.goto(`/settings/products/${fixtures.beta.product.id}?tab=developer`);
    await expect(launcher(page)).toBeVisible();
    await page.getByRole("button", { name: "Generate form key" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(launcher(page)).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(launcher(page)).toBeVisible();
  });

  test("a signed-in user keeps the thread; an expired session does not hand the support thread to the next person", async ({
    page,
    context,
  }) => {
    await signIn(page, owner.email, owner.password);
    await page.goto("/settings");
    await launcher(page).click();
    const frame = widgetFrame(page);
    await expect(frame.locator("#statusline")).toBeVisible();
    await frame.locator("#input").fill("Own-support question from the beta owner");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Own-support question");

    // Sign-in pages that also render for signed-in users keep their thread.
    await page.goto("/forgot-password");
    await launcher(page).click();
    await expect(widgetFrame(page).locator("#thread")).toContainText("Own-support question");

    // The dashboard session lapses (auth cookies gone); the widget's visitor
    // cookie and storage survive, as they do on a real shared device.
    await context.clearCookies({ name: /better-auth/u });
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/u);

    await launcher(page).click();
    const fresh = widgetFrame(page);
    await expect(fresh.locator("#statusline")).toBeVisible();
    await expect(fresh.locator("#thread")).not.toContainText("Own-support question");
  });

  test("a reset that never reached the widget panel is retried on the next visit", async ({ page, context }) => {
    await signIn(page, owner.email, owner.password);
    await page.goto("/settings");
    await launcher(page).click();
    const frame = widgetFrame(page);
    await frame.locator("#input").fill("Question that must not leak");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Question that must not leak");

    // The session lapses and the next person's first visit to the sign-in
    // page ends before the widget panel loads (slow network, closed tab): the
    // loader never builds, so the queued reset is lost with the document.
    await context.clearCookies({ name: /better-auth/u });
    await page.route("**/api/widget/config*", (route) => route.abort());
    await page.goto("/login");
    await expect(page.locator("#supportseal-widget-host")).toHaveCount(0);
    await page.unroute("**/api/widget/config*");

    await page.goto("/login");
    await launcher(page).click();
    const fresh = widgetFrame(page);
    await expect(fresh.locator("#statusline")).toBeVisible();
    await expect(fresh.locator("#thread")).not.toContainText("Question that must not leak");
  });
});
