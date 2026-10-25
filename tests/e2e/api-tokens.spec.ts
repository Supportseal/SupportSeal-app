import { expect, test, type Page } from "@playwright/test";

import { loadFixtures, onboardWorkspaceWithProduct, uniqueAccount } from "./helpers";

/**
 * Workspace API tokens (issue #187): an admin creates a token in Settings,
 * copies it (shown once), uses it as a Bearer credential on the read API,
 * and revokes it; the Beta fixture Workspace is the cross-tenant control.
 */
test.describe.serial("workspace API tokens", () => {
  const account = uniqueAccount();
  let page: Page;
  let token = "";
  let ownProductId = "";

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    page = await context.newPage();
    await onboardWorkspaceWithProduct(page, account, { name: "Token Desk", domain: "token.desk.test" });
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("admin creates a token that is shown once and can be copied", async () => {
    await page.goto("/settings/api-tokens");
    await page.locator("#token-name").fill("CI script");
    await page.getByRole("button", { name: "Create token" }).click();

    const banner = page.getByTestId("new-api-token");
    await expect(banner).toContainText("shown only once");
    token = ((await banner.locator("code").textContent()) ?? "").trim();
    expect(token).toMatch(/^ss_live_[A-Za-z0-9_-]{43}$/u);

    await banner.getByRole("button", { name: "Copy token" }).click();
    await expect(banner.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

    const row = page.getByRole("listitem").filter({ hasText: "CI script" });
    await expect(row).toContainText(`ss_live_…${token.slice(-4)}`);
    await expect(row).toContainText("Last used never");

    await page.reload();
    await expect(page.getByTestId("new-api-token")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(token);
  });

  test("the token reads this Workspace's Products and nothing else", async ({ request }) => {
    const bearer = { authorization: `Bearer ${token}` };

    const list = await request.get("/api/products", { headers: bearer });
    expect(list.status()).toBe(200);
    const { products } = (await list.json()) as { products: { id: string; name: string }[] };
    expect(products.map((p) => p.name)).toEqual(["Token Desk"]);
    ownProductId = products[0].id;

    expect((await request.get(`/api/products/${ownProductId}`, { headers: bearer })).status()).toBe(200);
    const beta = loadFixtures().beta.product;
    const cross = await request.get(`/api/products/${beta.id}`, { headers: bearer });
    expect(cross.status()).toBe(404);
    expect(await cross.text()).not.toContain(beta.key);

    await page.goto("/settings/api-tokens");
    await expect(page.getByRole("listitem").filter({ hasText: "CI script" })).not.toContainText(
      "Last used never",
    );
  });

  test("revoking stops the token immediately", async ({ request }) => {
    await page.goto("/settings/api-tokens");
    await page.getByRole("button", { name: "Revoke CI script" }).click();
    const row = page.getByRole("listitem").filter({ hasText: "CI script" });
    await expect(row).toContainText("revoked");
    await expect(page.getByRole("button", { name: "Revoke CI script" })).toHaveCount(0);

    const response = await request.get("/api/products", { headers: { authorization: `Bearer ${token}` } });
    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });
});
