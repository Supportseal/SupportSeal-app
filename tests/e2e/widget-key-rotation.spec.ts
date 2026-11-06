import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { HOST_PAGE, onboardWorkspaceWithProduct, openWidget, uniqueAccount } from "./helpers";

/**
 * Issue #19: an admin rotates the public widget key from the Widget tab. The
 * retired key stops booting the widget at once; the new key boots it.
 */
test.describe.serial("widget key rotation", () => {
  const account = uniqueAccount();
  const product = { name: "Rotation Desk", domain: "rotation.desk.test" };

  let adminPage: Page;
  let customerContext: BrowserContext;
  let oldKey = "";
  let productId = "";

  test.beforeAll(async ({ browser }) => {
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    adminPage = await adminContext.newPage();
    customerContext = await browser.newContext();
    oldKey = await onboardWorkspaceWithProduct(adminPage, account, product);
  });

  test.afterAll(async () => {
    await adminPage?.context().close();
    await customerContext?.close();
  });

  test("the current key boots the widget", async () => {
    const customerPage = await customerContext.newPage();
    await openWidget(customerPage, oldKey, { status: "Online" });
    await customerPage.close();
  });

  test("rotating from the Widget tab shows a new key and retires the old one", async () => {
    // First visit to the settings route compiles under `next dev`.
    test.setTimeout(120_000);
    await adminPage.goto("/settings/products");
    const href = await adminPage.locator('a[href^="/settings/products/"]').first().getAttribute("href");
    productId = href?.split("/").filter(Boolean).at(-1) ?? "";
    expect(productId).not.toBe("");

    await adminPage.goto(`/settings/products/${productId}?tab=widget`);
    await expect(adminPage.getByText(oldKey, { exact: true })).toBeVisible();

    await adminPage.getByRole("button", { name: "Rotate widget key" }).click();
    const dialog = adminPage.getByRole("dialog");
    await expect(dialog).toContainText("no grace period");
    await dialog.getByRole("button", { name: "Rotate key" }).click();
    await expect(adminPage.getByText("Widget key rotated")).toBeVisible();

    const keyShown = adminPage.getByText(/^pk_\S+$/u);
    await expect(keyShown).not.toHaveText(oldKey);
    const newKey = ((await keyShown.textContent()) ?? "").trim();
    expect(newKey).toMatch(/^pk_/u);
    expect(newKey).not.toBe(oldKey);
    // The embed snippet carries the new key.
    await expect(adminPage.locator("pre").first()).toContainText(`data-key="${newKey}"`);

    // Retired key: the config answer is a plain 404 (no CORS headers, so the
    // browser sees a failed request), and the loader never mounts the widget.
    const direct = await adminPage.request.get(
      `/api/widget/config?key=${encodeURIComponent(oldKey)}&host=${encodeURIComponent("http://localhost:3101")}`,
    );
    expect(direct.status()).toBe(404);
    const customerPage = await customerContext.newPage();
    const failed = customerPage.waitForEvent(
      "requestfailed",
      (request) => request.url().includes("/api/widget/config") && request.url().includes(oldKey),
    );
    await customerPage.goto(`${HOST_PAGE}&key=${encodeURIComponent(oldKey)}`);
    await failed;
    await expect(customerPage.locator("#supportseal-widget-host")).toHaveCount(0);
    await customerPage.close();

    // New key: boots and reports Online.
    const freshPage = await customerContext.newPage();
    await openWidget(freshPage, newKey, { status: "Online" });
    await freshPage.close();
  });
});
