import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  createProduct,
  openWidget,
  readInboundEmail,
  registerAccount,
  uniqueAccount,
  widgetFrame,
} from "./helpers";

/**
 * The condensed V1 acceptance flow (docs/FRD.md "Acceptance path"):
 * register → Workspace → Product A → live widget chat → agent reply →
 * identity/context → attachment → Product B → product switch → note, tag and
 * saved reply → close/reopen. Serial by design; the agent and the widget
 * visitor live in separate long-lived browser contexts.
 */
/** Open the composer's Saved palette; retries until the page has hydrated. */
async function openSavedPalette(page: Page) {
  await expect(async () => {
    if (await page.getByLabel("Search saved replies").isVisible()) return;
    await page.getByRole("button", { name: "Saved" }).click();
    await expect(page.getByLabel("Search saved replies")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
}

test.describe.serial("V1 acceptance flow", () => {
  const account = uniqueAccount();
  const productA = { name: "Alpha Chat", domain: "app.alpha.test" };
  const productB = { name: "Beacon Forms", colour: "#db2777", domain: "forms.beacon.test" };

  let agentPage: Page;
  let customerContext: BrowserContext;
  let customerPage: Page;
  let productAId = "";
  let productAKey = "";
  let productAInbound = "";
  let productBKey = "";
  let conversationAId = "";

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();

    customerContext = await browser.newContext();
    customerPage = await customerContext.newPage();
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await customerContext?.close();
  });

  test("register, create Workspace and Product A through onboarding", async () => {
    await registerAccount(agentPage, account);

    await agentPage.locator("#name").fill(account.workspace);
    await agentPage.getByRole("button", { name: "Continue" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/product/u);

    await agentPage.locator("#name").fill(productA.name);
    await agentPage.getByRole("button", { name: "Continue" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/domain/u);
  });

  test("configure Product A domains and reach the install step", async () => {
    await agentPage.locator("#domain").fill(productA.domain);
    await agentPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(agentPage.getByRole("button", { name: `Remove ${productA.domain}` })).toBeVisible();
    await agentPage.getByRole("button", { name: "Continue" }).click();
    // Optional Mail step: skipping must never block the wizard.
    await expect(agentPage).toHaveURL(/\/onboarding\/mail/u);
    await agentPage.getByRole("link", { name: "Skip for now" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/install/u);

    const snippet = (await agentPage.locator("pre").first().textContent()) ?? "";
    expect(snippet).toContain("/widget.js");
    const keyMatch = snippet.match(/data-key="(pk_[^"]+)"/u);
    expect(keyMatch).toBeTruthy();
    productAKey = keyMatch![1];

    await agentPage.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await agentPage.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(agentPage.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await agentPage.evaluate(() => navigator.clipboard.readText())).toBe(snippet);

    await expect(agentPage.getByRole("link", { name: "Open test page (new tab)" })).toBeVisible();
  });

  test("Product A appears in settings with its widget key", async () => {
    await agentPage.goto("/settings/products");
    const row = agentPage.getByRole("table").getByRole("link", { name: new RegExp(productA.name, "u") });
    await expect(row).toBeVisible();
    const href = await row.getAttribute("href");
    productAId = href?.match(/\/settings\/products\/([^/?]+)/u)?.[1] ?? "";
    expect(productAId).not.toBe("");

    await agentPage.goto(`/settings/products/${productAId}?tab=widget`);
    await expect(agentPage.getByText(/^pk_\S+$/u)).toHaveText(productAKey);
  });

  test("product creation generated a copyable inbound email (issue #45)", async () => {
    productAInbound = await readInboundEmail(agentPage, productAId);
    expect(productAInbound).toMatch(/^product_[a-z0-9_-]+@inbound\.localhost$/u);
    await expect(
      agentPage.getByRole("button", { name: "Copy address" }),
    ).toBeVisible();
    await expect(agentPage.getByText(/forward your support address/iu).first()).toBeVisible();
    await expect(agentPage.getByText("Waiting for the first email")).toBeVisible();
  });

  test("visitor chat completes the waiting install step and links to the inbox", async () => {
    await agentPage.goto("/onboarding/install");
    await expect(agentPage.getByText("Waiting for your first message")).toBeVisible();

    const frame = await openWidget(customerPage, productAKey, { status: "Online" });
    await frame.locator("#input").fill("Hello! The export button is broken on Safari.");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("export button is broken");

    await expect(agentPage.getByText("First message received")).toBeVisible({ timeout: 20_000 });
    await agentPage.getByRole("link", { name: "Open it in your inbox" }).click();
    await expect(agentPage).toHaveURL(/\/inbox\/?$/u);

    const firstRow = agentPage.locator('ul[aria-label="Conversations"] li a').first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();
    await expect(agentPage).toHaveURL(/\/inbox\/[^/]+\/?$/u);
    conversationAId = agentPage.url().match(/\/inbox\/([^/?]+)/u)![1];
    await expect(agentPage.getByText(productA.name).first()).toBeVisible();
  });

  test("finished onboarding sends Get started to the add-Product flow", async () => {
    // The install-and-test step already succeeded, so the Get started
    // funnel (/onboarding → /onboarding/install) opens the add-Product flow.
    await agentPage.goto("/onboarding");
    await expect(agentPage).toHaveURL(/\/settings\/products\/?$/u);
    await expect(agentPage.getByRole("heading", { name: "Products" })).toBeVisible();

    // With a Product in the Workspace the sidebar drops the "Get started"
    // entry. The first conversation completes both required checklist items
    // ("Install the widget", "Send a test message"), so the sidebar chip is
    // gone; the 2-of-6 checklist stays reachable under Settings.
    await agentPage.goto("/inbox");
    await expect(agentPage.getByRole("link", { name: "Get started" })).toHaveCount(0);
    await expect(agentPage.getByRole("link", { name: /^Setup \d of \d complete/u })).toHaveCount(0);
    await agentPage.goto("/settings/setup");
    await expect(agentPage.getByRole("heading", { name: "Setup checklist" })).toBeVisible();
    await expect(agentPage.getByText("2 of 6 complete")).toBeVisible();
    await agentPage.goto("/inbox");

    // Land back inside the conversation (client-side nav; the reply test
    // picks up from here).
    const firstRow = agentPage.locator('ul[aria-label="Conversations"] li a').first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();
    await expect(agentPage).toHaveURL(/\/inbox\/[^/]+\/?$/u);
  });

  test("agent replies and the visitor receives it in near real time", async () => {
    const reply = "Thanks for the report — which Safari version are you on?";
    await agentPage.getByLabel(/^Reply to /u).fill(reply);
    await agentPage.getByRole("button", { name: "Send", exact: true }).click();

    await expect(
      agentPage.getByRole("article").filter({ hasText: reply }).first(),
    ).toBeVisible();
    await expect(agentPage.locator("header").getByText("Pending").first()).toBeVisible();

    const frame = widgetFrame(customerPage);
    await expect(frame.locator("#thread")).toContainText(reply, { timeout: 20_000 });
  });

  test("developer SDK identity and context appear beside the conversation", async () => {
    await customerPage.evaluate(() => {
      const widget = (
        window as unknown as {
          SupportSealWidget?: { identify: (data: unknown) => void; context: (data: unknown) => void };
        }
      ).SupportSealWidget;
      widget?.identify({ userId: "usr_2041", name: "Sam Customer" });
      widget?.context({ plan: "Pro", account: "acme-inc", appVersion: "2.1.0" });
    });

    const panel = agentPage.locator("aside");
    await expect(
      panel.getByText(`Identified by ${productA.name} as user`, { exact: false }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(`Context from ${productA.name}`)).toBeVisible();
    await expect(panel.getByText("usr_2041")).toBeVisible();
    await expect(panel.getByText("Pro", { exact: true })).toBeVisible();
    await expect(panel.getByText("acme-inc")).toBeVisible();
  });

  test("visitor uploads an attachment the agent can see", async () => {
    const frame = widgetFrame(customerPage);
    await frame.locator("#fileInput").setInputFiles({
      name: "console.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("TypeError: undefined is not an object (evaluating 'csv.headers')"),
    });
    await expect(frame.getByText("console.txt").first()).toBeVisible();
    await frame.locator("#input").fill("Console log attached.");
    await frame.locator("#send").click();

    await expect(agentPage.getByRole("link", { name: /console\.txt/u }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("visitor volunteers an email for later replies (FR-CHAT-04)", async () => {
    const frame = widgetFrame(customerPage);
    await expect(frame.locator("#captureEmail")).toBeVisible();
    await frame.locator("#captureEmail").fill("sam@customer.test");
    await frame.locator("#captureSave").click();
    await expect(frame.locator("#thread")).toContainText("sam@customer.test", { timeout: 10_000 });

    // The capture updates the contact, not the conversation thread, so the
    // already-open inbox view needs a reload to pick it up.
    await agentPage.reload();
    await expect(agentPage.getByText("sam@customer.test").first()).toBeVisible({ timeout: 20_000 });
  });

  test("create Product B and start a conversation on it", async () => {
    const createdB = await createProduct(agentPage, productB);
    productBKey = createdB.key;
    // Every Product gets its own distinct inbound address.
    expect(createdB.inboundEmail).toMatch(/^product_[a-z0-9_-]+@inbound\.localhost$/u);
    expect(createdB.inboundEmail).not.toBe(productAInbound);

    const frame = await openWidget(customerPage, productBKey, { status: "Online" });
    await frame.locator("#input").fill("Hi Beacon team, how do I embed the form?");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("embed the form");
  });

  test("unified inbox lists both Products; filter switches scope and back", async () => {
    // The agent reply moved conversation A to Pending, so cover both tabs.
    await agentPage.goto("/inbox?status=PENDING");
    const list = agentPage.locator('ul[aria-label="Conversations"]');
    await expect(list.getByText(productA.name).first()).toBeVisible();
    await agentPage.getByRole("tab", { name: /Open/u }).click();
    await expect(list.getByText(productB.name).first()).toBeVisible({ timeout: 20_000 });

    await agentPage.goto(`/inbox?product=${productAId}&status=PENDING`);
    await expect(agentPage.getByText("Product scope")).toBeVisible();
    await expect(list.getByText(productA.name).first()).toBeVisible();
    await expect(list.getByText(productB.name)).toHaveCount(0);

    await agentPage.getByLabel("Show all Products").click();
    await expect(agentPage.getByText("All Products")).toBeVisible();
    await expect(list.getByText(productA.name).first()).toBeVisible({ timeout: 20_000 });
  });

  test("internal note is visible to agents but never to the visitor", async () => {
    const note = "Internal: Safari 18.2 export bug, tracked as ENG-412.";
    await agentPage.goto(`/inbox/${conversationAId}`);
    // Retry the tab switch: the first click can land before hydration wires
    // up the composer tabs on a freshly loaded page.
    await expect(async () => {
      if (await agentPage.getByLabel("Internal note").isVisible()) return;
      await agentPage.getByRole("tab", { name: "Note" }).click();
      await expect(agentPage.getByLabel("Internal note")).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 15_000 });
    await agentPage.getByLabel("Internal note").fill(note);
    await agentPage.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(
      agentPage.getByRole("article", { name: /Internal note by /u }).filter({ hasText: note }),
    ).toBeVisible();

    const frame = await openWidget(customerPage, productAKey, { status: "Online" });
    await expect(frame.locator("#thread")).toContainText("export button is broken");
    await expect(frame.locator("#thread")).not.toContainText("ENG-412");
  });

  test("agent tags the conversation", async () => {
    await agentPage.getByLabel("Add tag").fill("safari");
    await agentPage.getByLabel("Add tag").press("Enter");
    await expect(agentPage.getByLabel("Remove tag safari")).toBeVisible({ timeout: 20_000 });

    await agentPage.goto("/inbox?status=PENDING");
    await expect(
      agentPage.locator('ul[aria-label="Conversations"]').getByText("safari").first(),
    ).toBeVisible();
  });

  test("saved reply can be created and inserted into the composer", async () => {
    await agentPage.goto("/saved-replies");
    await agentPage.locator("#name").fill("Safari export fix");
    await agentPage.locator("#body").fill("The Safari export fix ships in 2.2 — please update.");
    await agentPage.getByRole("button", { name: "Save reply" }).click();
    await expect(agentPage.getByRole("cell", { name: "Safari export fix", exact: true })).toBeVisible();

    await agentPage.goto(`/inbox/${conversationAId}`);
    await openSavedPalette(agentPage);
    await agentPage.getByRole("option", { name: /Safari export fix/u }).click();
    await expect(agentPage.getByLabel(/^Reply to /u)).toHaveValue(
      "The Safari export fix ships in 2.2 — please update.",
    );
    await agentPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      agentPage
        .getByRole("article")
        .filter({ hasText: "The Safari export fix ships in 2.2" })
        .first(),
    ).toBeVisible();
  });

  test("saved replies are scoped to one or several Products and insert from both entry points (issues #139, #200)", async () => {
    const alphaOnly = { name: "Alpha only", body: "Alpha-only: update the Alpha Chat widget snippet." };
    const beaconOnly = { name: "Beacon only", body: "Beacon-only: re-publish the form after editing." };
    const bothProducts = { name: "Both products", body: "Both: clear the cache after republishing." };
    const availability = agentPage.getByRole("group", { name: "Available in" });

    await agentPage.goto("/saved-replies");
    for (const [reply, products] of [
      [alphaOnly, [productA.name]],
      [beaconOnly, [productB.name]],
      // Multi-select (issue #200): several Products in one reply.
      [bothProducts, [productA.name, productB.name]],
    ] as const) {
      await agentPage.locator("#name").fill(reply.name);
      await agentPage.locator("#body").fill(reply.body);
      for (const product of products) {
        await availability.getByRole("checkbox", { name: product }).check();
      }
      await agentPage.getByRole("button", { name: "Save reply" }).click();
      await expect(agentPage.getByRole("cell", { name: reply.name, exact: true })).toBeVisible();
    }

    // Management page shows each reply's availability and filters by it. The
    // earlier reply was created with the default scope = All products.
    const cell = (name: string) => agentPage.getByRole("cell", { name, exact: true });
    const row = (name: RegExp) => agentPage.getByRole("row", { name });
    await expect(row(/Safari export fix/u).getByText("All products")).toBeVisible();
    await expect(
      row(/Alpha only/u).getByText(productA.name, { exact: true }),
    ).toBeVisible();
    const bothRow = row(/Both products/u);
    await expect(bothRow.getByText(productA.name, { exact: true })).toBeVisible();
    await expect(bothRow.getByText(productB.name, { exact: true })).toBeVisible();
    const filters = agentPage.getByRole("navigation", { name: "Filter by scope" });
    await filters.getByRole("link", { name: productB.name }).click();
    await expect(cell(beaconOnly.name)).toBeVisible();
    await expect(cell(bothProducts.name)).toBeVisible();
    await expect(cell(alphaOnly.name)).toHaveCount(0);
    await expect(cell("Safari export fix")).toHaveCount(0);
    await filters.getByRole("link", { name: "Workspace-wide" }).click();
    await expect(cell("Safari export fix")).toBeVisible();
    await expect(cell(alphaOnly.name)).toHaveCount(0);
    await expect(cell(beaconOnly.name)).toHaveCount(0);
    await expect(cell(bothProducts.name)).toHaveCount(0);

    // Conversation A (Product A): Saved button → All-products + Product A replies.
    await agentPage.goto(`/inbox/${conversationAId}`);
    const composerA = agentPage.getByLabel(/^Reply to /u);
    await openSavedPalette(agentPage);
    await expect(agentPage.getByRole("option", { name: /Safari export fix/u })).toBeVisible();
    await expect(agentPage.getByRole("option", { name: /Alpha only/u })).toBeVisible();
    await expect(agentPage.getByRole("option", { name: /Both products/u })).toBeVisible();
    await expect(agentPage.getByRole("option", { name: /Beacon only/u })).toHaveCount(0);
    // Search + keyboard: filter, Enter inserts, focus returns to the composer.
    await agentPage.getByLabel("Search saved replies").fill("alpha");
    await expect(agentPage.getByRole("option")).toHaveCount(1);
    await agentPage.getByLabel("Search saved replies").press("Enter");
    await expect(composerA).toHaveValue(alphaOnly.body);
    await expect(composerA).toBeFocused();

    // "/" opens the same palette in the composer.
    await composerA.fill("");
    await composerA.pressSequentially("/");
    const listbox = agentPage.getByRole("listbox", { name: "Saved replies" });
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole("option", { name: /Safari export fix/u })).toBeVisible();
    await expect(listbox.getByRole("option", { name: /Beacon only/u })).toHaveCount(0);
    await composerA.pressSequentially("alp");
    await expect(listbox.getByRole("option")).toHaveCount(1);
    await composerA.press("Enter");
    await expect(composerA).toHaveValue(alphaOnly.body);
    await expect(listbox).toHaveCount(0);

    // Arrow keys move the highlight; Escape closes without inserting.
    await composerA.fill("");
    await composerA.pressSequentially("/");
    await expect(listbox.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await composerA.press("ArrowDown");
    await expect(listbox.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    await composerA.press("Escape");
    await expect(listbox).toHaveCount(0);
    await expect(composerA).toHaveValue("/");
    await composerA.fill("");

    // Conversation B (Product B): Beacon + Workspace-wide, never Alpha-only.
    await agentPage.goto("/inbox?status=OPEN");
    await agentPage
      .locator('ul[aria-label="Conversations"]')
      .getByRole("link", { name: new RegExp(productB.name, "u") })
      .first()
      .click();
    await expect(agentPage).toHaveURL(/\/inbox\/[^/]+\/?$/u);
    const composerB = agentPage.getByLabel(/^Reply to /u);
    await expect(async () => {
      await composerB.fill("");
      await composerB.pressSequentially("/");
      await expect(listbox).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(listbox.getByRole("option", { name: /Beacon only/u })).toBeVisible();
    await expect(listbox.getByRole("option", { name: /Both products/u })).toBeVisible();
    await expect(listbox.getByRole("option", { name: /Safari export fix/u })).toBeVisible();
    await expect(listbox.getByRole("option", { name: /Alpha only/u })).toHaveCount(0);
    await composerB.pressSequentially("beacon");
    await composerB.press("Enter");
    await expect(composerB).toHaveValue(beaconOnly.body);
  });

  test("a draft can be saved as a reply from the composer and re-offered (issue #200)", async () => {
    await agentPage.goto("/inbox?status=OPEN");
    await agentPage
      .locator('ul[aria-label="Conversations"]')
      .getByRole("link", { name: new RegExp(productB.name, "u") })
      .first()
      .click();
    await expect(agentPage).toHaveURL(/\/inbox\/[^/]+\/?$/u);
    const composer = agentPage.getByLabel(/^Reply to /u);
    const draft = "Beacon draft: re-publish the form, then hard-refresh the dashboard.";
    await composer.fill(draft);

    // Save reply (next to Send) opens the modal with the draft pre-filled.
    await agentPage.getByRole("button", { name: "Save reply" }).click();
    const dialog = agentPage.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#save-reply-body")).toHaveValue(draft);
    await dialog.locator("#save-reply-name").fill("Beacon draft reply");
    await dialog
      .getByRole("group", { name: "Available in" })
      .getByRole("checkbox", { name: productB.name })
      .check();
    await dialog.getByRole("button", { name: "Save reply" }).click();
    await expect(dialog).not.toBeVisible();

    // Saving never clears or sends the draft.
    await expect(composer).toHaveValue(draft);

    // The saved reply is offered again in this Product's palette.
    await expect(async () => {
      await openSavedPalette(agentPage);
      await expect(
        agentPage.getByRole("option", { name: /Beacon draft reply/u }),
      ).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await agentPage.keyboard.press("Escape");
    await composer.fill("");
  });

  test("closing a conversation and getting a visitor message reopens it", async () => {
    // Retry the whole close: the first click can land before hydration wires
    // up the button on a freshly loaded page.
    await expect(async () => {
      await agentPage.goto(`/inbox/${conversationAId}`);
      await expect(agentPage.getByRole("button", { name: "Close", exact: true })).toBeVisible();
      await agentPage.getByRole("button", { name: "Close", exact: true }).click();
      // A is Pending, so the Open list beside the thread has no next
      // conversation: Close lands on the empty state (#199).
      await expect(agentPage).toHaveURL(/\/inbox\/?(\?.*)?$/u, { timeout: 8_000 });
    }).toPass({ timeout: 40_000 });
    await agentPage.goto(`/inbox/${conversationAId}`);
    await expect(agentPage.getByRole("button", { name: "Reopen" })).toBeVisible();
    await expect(agentPage.locator("header").getByText("Closed").first()).toBeVisible();

    const frame = await openWidget(customerPage, productAKey, { status: "Online" });
    await frame.locator("#input").fill("One more thing — still broken after updating.");
    await frame.locator("#send").click();

    await expect(
      agentPage.getByText("One more thing — still broken after updating.").first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(agentPage.locator("header").getByText("Open").first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
