import { expect, test } from "@playwright/test";
import { registerAccount, uniqueAccount } from "./helpers";

test("domains card explains exact matching and offers the apex/www counterpart", async ({ page }) => {
  const account = uniqueAccount();
  await registerAccount(page, account);
  await page.locator("#name").fill(account.workspace);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding\/product/u);
  await page.locator("#name").fill("Apex www probe");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding\/domain/u);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("link", { name: "Skip for now" }).click();
  await page.getByRole("link", { name: "Add a domain in Product settings" }).click();

  const card = page.locator("#domains");
  await expect(card).toContainText("separate entries");
  await expect(card).toContainText("but not");

  // A pasted URL is normalised and the www counterpart is offered (ticked by default).
  await card.locator("#domain").fill("https://Example.com/pricing");
  const both = card.getByLabel("Also allow www.example.com");
  await expect(both).toBeChecked();
  await card.getByRole("button", { name: "Add", exact: true }).click();
  const rows = card.locator("li .font-mono");
  await expect(rows).toHaveText(["example.com", "www.example.com"]);

  // Offer is gone when the counterpart is already allowed; subdomains get no offer.
  await card.locator("#domain").fill("example.com");
  await expect(card.getByLabel(/Also allow/u)).toHaveCount(0);
  await card.locator("#domain").fill("app.shop.test");
  await expect(card.getByLabel(/Also allow/u)).toHaveCount(0);

  // Unticking adds only the pasted hostname; typing www offers the apex.
  await card.locator("#domain").fill("www.other.test");
  await card.getByLabel("Also allow other.test").uncheck();
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await expect(rows).toHaveText(["example.com", "www.example.com", "www.other.test"]);
});
