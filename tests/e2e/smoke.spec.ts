import { expect, test } from "@playwright/test";

import { loadFixtures, signIn, uniqueAccount, registerAccount } from "./helpers";

/**
 * Infrastructure smoke: the app server boots against a fresh database, the
 * seeded cross-Workspace fixture exists, and the auth round-trip works.
 */
test.describe.serial("e2e infrastructure", () => {
  test("health endpoint is green", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", database: "ok" });
  });

  test("hosted fixtures are seeded", () => {
    const fixtures = loadFixtures();
    expect(fixtures.beta.workspace.name).toBe("Beta Workspace");
    expect(fixtures.beta.product.key).toMatch(/^pk_/u);
    expect(fixtures.beta.product.inboundEmail).toBe("support@beta.test");
  });

  test("beta fixture owner can sign in and reach the inbox", async ({ page }) => {
    const fixtures = loadFixtures();
    await signIn(page, fixtures.beta.owner.email, fixtures.beta.owner.password);
    await expect(page.getByRole("tablist", { name: "Conversation status" })).toBeVisible();
  });

  test("registration is open in hosted mode", async ({ page }) => {
    const account = uniqueAccount();
    await registerAccount(page, account);
    await expect(page.getByRole("heading", { name: "Create your Workspace" })).toBeVisible();
  });
});
