import { expect, test, type Page } from "@playwright/test";

import { onboardWorkspaceWithProduct, openWidget, uniqueAccount } from "./helpers";

/**
 * Custom widget greeting (docs/design/branding.md BR-04, BR-08, BR-09): an
 * Admin edits it on the Widget tab with a live preview, the real widget shows
 * it as literal text before the first message (above the form while Away),
 * hides it once a message is sent, never adds it to resumed history, and an
 * empty value restores the built-in greeting.
 */
test.describe.serial("widget greeting", () => {
  const account = uniqueAccount();
  const greeting = 'Hi from <b>Greet Desk</b>!\nWe answer within a day. <script>window.__pwned = 1</script>';
  let agentPage: Page;
  let productKey = "";
  let productId = "";

  test.beforeAll(async ({ browser }) => {
    agentPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    productKey = await onboardWorkspaceWithProduct(agentPage, account, { name: "Greet Desk", domain: "greet.desk.test" });
    await agentPage.goto("/settings/products");
    const row = agentPage.getByRole("table").getByRole("link", { name: /Greet Desk/u });
    productId = (await row.getAttribute("href"))?.match(/\/settings\/products\/([^/?]+)/u)?.[1] ?? "";
    expect(productId).not.toBe("");
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
  });

  /** The panel inside the Widget tab's preview iframe (previews open it themselves). */
  async function openPreviewPanel() {
    // The draft reaches the preview after a typing pause, as a fresh iframe.
    await expect(agentPage.locator('iframe[title="Greet Desk widget preview"]')).toHaveAttribute("src", /greeting=Hi/u);
    const preview = agentPage.frameLocator('iframe[title="Greet Desk widget preview"]');
    return preview.frameLocator("#supportseal-widget-host iframe");
  }

  test("Widget tab validates, previews the draft, then saves it", async () => {
    // Cold-compiles the settings page, the preview page and the panel.
    test.setTimeout(180_000);
    await agentPage.goto(`/settings/products/${productId}?tab=widget`);
    const field = agentPage.getByLabel("Greeting text");
    await expect(field).toHaveAttribute("placeholder", "Ask us anything, we’re here.");
    const save = agentPage.getByRole("button", { name: "Save greeting" });
    await expect(save).toBeDisabled();

    await field.fill("one\ntwo\nthree\nfour");
    await expect(agentPage.getByText("Greeting can have at most 3 lines (it has 4).")).toBeVisible();
    await expect(save).toBeDisabled();

    await field.fill(greeting);
    await expect(agentPage.getByText("2/3 lines")).toBeVisible();
    await expect(save).toBeEnabled();

    // Unsaved draft in the preview, as literal text.
    const panel = await openPreviewPanel();
    await expect(panel.locator("#greeting")).toHaveText(greeting);
    await expect(panel.locator("#greeting b, #greeting script")).toHaveCount(0);

    await save.click();
    await expect(agentPage.getByText("Greeting saved.")).toBeVisible();
    await agentPage.reload();
    await expect(agentPage.getByLabel("Greeting text")).toHaveValue(greeting);
  });

  test("the real widget shows it before the first message only, as text", async ({ page }) => {
    const frame = await openWidget(page, productKey, { status: "Online" });
    const shown = frame.locator("#greeting");
    await expect(shown).toHaveText(greeting);
    await expect(shown).toHaveAttribute("dir", "auto");
    await expect(frame.locator("#greeting b, #greeting script")).toHaveCount(0);
    expect(await page.frames().at(-1)?.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    await frame.locator("#input").fill("Question for the greeting test");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Question for the greeting test");
    await expect(shown).toHaveCount(0);

    // Resumed history gains no greeting.
    await page.reload();
    const resumed = await openWidget(page, productKey, { status: "Online" });
    await expect(resumed.locator("#thread")).toContainText("Question for the greeting test");
    await expect(resumed.locator("#greeting")).toHaveCount(0);
  });

  test("Away shows it above the message form", async ({ browser }) => {
    await agentPage.goto("/inbox");
    const availability = agentPage.getByRole("radiogroup", { name: "Support availability" });
    await availability.getByRole("radio", { name: "Away" }).click();
    await expect(availability).toHaveAttribute("aria-busy", "false");
    try {
      const visitor = await browser.newContext();
      const frame = await openWidget(await visitor.newPage(), productKey, { status: "Away" });
      await expect(frame.locator("#awayGreeting")).toBeVisible();
      await expect(frame.locator("#awayGreeting")).toHaveText(greeting);
      await visitor.close();
    } finally {
      await availability.getByRole("radio", { name: "Live" }).click();
      await expect(availability).toHaveAttribute("aria-busy", "false");
    }
  });

  test("clearing it restores the built-in greeting", async ({ page }) => {
    await agentPage.goto(`/settings/products/${productId}?tab=widget`);
    await agentPage.getByLabel("Greeting text").fill("   ");
    await agentPage.getByRole("button", { name: "Save greeting" }).click();
    await expect(agentPage.getByText("Greeting saved.")).toBeVisible();
    await expect(agentPage.getByLabel("Greeting text")).toHaveValue("");

    const frame = await openWidget(page, productKey, { status: "Online" });
    await expect(frame.locator("#greeting")).toHaveText("Ask us anything, we’re here.");
  });
});
