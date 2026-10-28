import { expect, test } from "@playwright/test";

import { uniqueAccount } from "./helpers";

/**
 * Choose Pro / Choose Business on the marketing pricing page link to
 * /register?plan=…&interval=…; the pick must survive sign-up and Workspace
 * creation and land the new admin on checkout for that plan (audit B3).
 */
test.describe("plan picked on the pricing page", () => {
  test("carries through sign-up to the billing page, preselected", async ({ page }) => {
    const account = uniqueAccount();
    await page.goto("/register?plan=business&interval=year");
    await expect(page.getByText("You picked Business (annual).")).toBeVisible();

    await page.locator("#name").fill(account.name);
    await page.locator("#email").fill(account.email);
    await page.locator("#password").fill(account.password);
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/onboarding/u);

    await page.locator("#name").fill(account.workspace);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/settings\/billing\?plan=business&interval=year/u);
    await expect(page.getByText("Finish upgrading to Business")).toBeVisible();
    await expect(page.getByRole("button", { name: "Annual (2 months free)" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Continue to Business checkout" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();

    // The pick is used once: setup continues normally afterwards.
    await page.getByRole("link", { name: "set up your first product" }).click();
    await expect(page).toHaveURL(/\/onboarding\/product/u);

    // A signed-in visitor who picks a plan goes straight to checkout.
    await page.goto("/register?plan=pro");
    await expect(page).toHaveURL(/\/settings\/billing\?plan=pro&interval=month/u);
    await expect(page.getByRole("button", { name: "Continue to Pro checkout" })).toBeVisible();
  });

  test("ignores an unknown plan", async ({ page }) => {
    await page.goto("/register?plan=enterprise");
    await expect(page.getByText("Create your account")).toBeVisible();
    await expect(page.locator("[data-plan-intent]")).toHaveCount(0);
  });
});
