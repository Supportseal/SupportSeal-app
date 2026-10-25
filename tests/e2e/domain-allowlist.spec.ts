import { expect, test } from "@playwright/test";
import { registerAccount, uniqueAccount } from "./helpers";

test("onboarding captures domains and skipped setup warns beside both install snippets", async ({ page, browser }) => {
  const account = uniqueAccount();
  await registerAccount(page, account);
  await page.locator("#name").fill(account.workspace);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding\/product/u);
  await page.locator("#name").fill("Domain setup probe");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/onboarding\/domain/u);
  await expect(page.getByRole("status")).toContainText("The widget only loads on listed domains");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/onboarding\/install/u);
  await expect(page.getByRole("alert").filter({ hasText: "No allowed domains yet" })).toContainText("No allowed domains yet");
  const snippet = await page.locator("pre").first().innerText();
  const key = snippet.match(/data-key="([^"]+)"/u)![1];
  const settingsLink = page.getByRole("link", { name: "Add a domain in Product settings" });
  const settings = (await settingsLink.getAttribute("href"))!.split("#")[0];
  await settingsLink.click();
  await expect(page.locator("#domains")).toBeVisible();
  await page.goto(`${settings}?tab=widget`);
  await expect(page.getByRole("alert").filter({ hasText: "No allowed domains yet" })).toContainText("No allowed domains yet");

  const customer = await browser.newPage();
  try {
    await customer.context().grantPermissions(["local-network-access"]);
    // A separate loopback host avoids private-network restrictions but is not in the dev allowlist.
    await customer.route("http://127.0.0.2:3101/", route => route.fulfill({
      contentType: "text/html",
      body: `<script src="http://localhost:3100/widget.js" data-key="${key}"></script>`,
    }));
    const errors: string[] = [];
    customer.on("console", message => {
      if (message.type() === "error" && message.text().includes("Widget not loaded:")) errors.push(message.text());
    });
    await customer.goto("http://127.0.0.2:3101/");
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0]).toContain("127.0.0.2");
    await expect(customer.locator("#supportseal-widget-host")).toHaveCount(0);
  } finally {
    await customer.close();
  }

  await page.goto("/onboarding/domain");
  await page.locator("#domain").fill("customer.example.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/onboarding\/install/u);
  await expect(page.getByRole("alert").filter({ hasText: "No allowed domains yet" })).toHaveCount(0);
  await page.goto(`${settings}?tab=widget`);
  await expect(page.getByRole("alert").filter({ hasText: "No allowed domains yet" })).toHaveCount(0);
});
