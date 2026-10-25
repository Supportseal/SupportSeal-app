import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  diagHostPageFor,
  enableDiagnostics,
  hostPageFor,
  openWidget,
  registerAccount,
  signIn,
  uniqueAccount,
} from "../helpers";

/**
 * Self-hosted core flows (FR-HOST-01): the default deployment mode runs the
 * same onboarding + chat + inbox workflow, represents exactly one Workspace
 * (registration closes once it exists; the advisory-lock block on a second
 * Workspace is covered by src/lib/__tests__/workspace.test.ts) and never
 * exposes hosted billing.
 */
const APP = "http://localhost:3200";

test.describe.serial("self-hosted mode core flows", () => {
  const account = uniqueAccount();
  const product = { name: "Solo Desk", domain: "solo.desk.test" };

  let agentPage: Page;
  let customerContext: BrowserContext;
  let productKey = "";
  let inviteeEmail = "";

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({
      baseURL: APP,
      viewport: { width: 1440, height: 900 },
    });
    agentPage = await agentContext.newPage();
    customerContext = await browser.newContext();
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await customerContext?.close();
  });

  test("the root of a fresh installation opens registration", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/register\/?$/u);
  });

  test("onboarding works: register, one Workspace, one Product", async () => {
    await registerAccount(agentPage, account);
    await expect(agentPage).toHaveURL(/\/onboarding\/?$/u);

    await agentPage.locator("#name").fill(account.workspace);
    await agentPage.getByRole("button", { name: "Continue" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/product/u);

    await agentPage.locator("#name").fill(product.name);
    await agentPage.getByRole("button", { name: "Continue" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/domain/u);

    await agentPage.locator("#domain").fill(product.domain);
    await agentPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      agentPage.getByRole("button", { name: `Remove ${product.domain}` }),
    ).toBeVisible();
    await agentPage.getByRole("button", { name: "Continue" }).click();
    // Optional Mail step: skipping must never block the wizard.
    await expect(agentPage).toHaveURL(/\/onboarding\/mail/u);
    await agentPage.getByRole("link", { name: "Skip for now" }).click();
    await expect(agentPage).toHaveURL(/\/onboarding\/install/u);

    const snippet = (await agentPage.locator("pre").first().textContent()) ?? "";
    productKey = snippet.match(/data-key="(pk_[^"]+)"/u)?.[1] ?? "";
    expect(productKey).toMatch(/^pk_/u);
  });

  test("chat widget and agent reply work end to end", async () => {
    const page = await customerContext.newPage();
    const frame = await openWidget(page, productKey, {
      hostPage: hostPageFor(APP),
      status: "Online",
    });
    await frame.locator("#input").fill("Self-hosted chat message 4c1f");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Self-hosted chat message 4c1f");
    await page.close();

    await agentPage.goto("/inbox");
    const row = agentPage.locator('ul[aria-label="Conversations"] li a').first();
    await expect(row).toBeVisible();
    await row.click();
    const reply = "Reply from the self-hosted inbox.";
    await agentPage.getByLabel(/^Reply to /u).fill(reply);
    await agentPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      agentPage.getByRole("article").filter({ hasText: reply }).first(),
    ).toBeVisible();
  });

  test("registration closes once the Workspace exists", async ({ request, page }) => {
    const response = await request.post("/api/auth/sign-up/email", {
      headers: { "content-type": "application/json", origin: APP },
      data: {
        name: "Latecomer",
        email: "latecomer@e2e.test",
        password: "correct-horse-late",
      },
    });
    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({ code: "user-creation-disabled" });

    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "Registration is closed" })).toBeVisible();

    // Once the Workspace exists, the root presents sign-in to visitors and
    // sends the signed-in agent to the inbox.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login\/?$/u);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await agentPage.goto("/");
    await expect(agentPage).toHaveURL(/\/inbox\/?$/u);
  });

  test("an invited teammate creates an account from the invite link (#180)", async ({ browser }) => {
    test.skip(!productKey, "core onboarding did not run");
    await agentPage.goto("/settings/team");
    inviteeEmail = `invitee-${Date.now()}@e2e.test`;
    await agentPage.getByLabel("Email").fill(inviteeEmail);
    await agentPage.getByRole("button", { name: "Create invite" }).click();
    const inviteUrl = (await agentPage.locator("code").first().textContent()) ?? "";
    expect(inviteUrl).toContain("/invite/");

    const inviteeContext = await browser.newContext({ baseURL: APP });
    const inviteePage = await inviteeContext.newPage();
    await inviteePage.goto(inviteUrl);
    await expect(
      inviteePage.getByRole("heading", { name: `Join ${account.workspace}` }),
    ).toBeVisible();
    await inviteePage.locator("#invite-name").fill("Invited Teammate");
    await expect(inviteePage.locator("#invite-email")).toHaveValue(inviteeEmail);
    await inviteePage.locator("#invite-password").fill("correct-horse-invitee");
    await inviteePage.getByRole("button", { name: "Create account and join" }).click();
    await expect(inviteePage).toHaveURL(/\/inbox\/?$/u);

    // The consumed invite no longer admits anyone.
    const replayContext = await browser.newContext({ baseURL: APP });
    const replayPage = await replayContext.newPage();
    await replayPage.goto(inviteUrl);
    await expect(replayPage.getByRole("heading", { name: "Invite not available" })).toBeVisible();
    await replayContext.close();
    await inviteeContext.close();
  });

  test("a non-admin member cannot see or reach the API tokens page (#187)", async ({ browser }) => {
    test.skip(!inviteeEmail, "invite flow did not run");
    const memberContext = await browser.newContext({ baseURL: APP });
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, inviteeEmail, "correct-horse-invitee");

    await memberPage.goto("/settings/team");
    await expect(memberPage.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await expect(memberPage.getByRole("link", { name: "API tokens" })).toHaveCount(0);

    await memberPage.goto("/settings/api-tokens");
    await expect(memberPage).toHaveURL(/\/settings\/team\/?$/u);
    await expect(memberPage.getByRole("heading", { name: "API tokens" })).toHaveCount(0);
    await expect(memberPage.locator("body")).not.toContainText("Create a token");
    await memberContext.close();
  });

  test("hosted billing is absent", async () => {
    const response = await agentPage.goto("/settings/billing");
    expect(response?.url()).toContain("/settings/team");

    const checkout = await agentPage.request.post("/api/billing/checkout");
    expect(checkout.status()).toBe(404);
    expect(await checkout.json()).toMatchObject({ error: "not_available" });

    await agentPage.goto("/settings/team");
    await expect(agentPage.getByRole("tab", { name: "Billing" })).toHaveCount(0);
  });

  const CANARIES = [
    "CANARY_COOKIE",
    "CANARY_STORAGE",
    "CANARY_SESSION",
    "CANARY_PASSWORD",
    "CANARY_AUTH",
    "CANARY_BODY",
    "CANARY_LOG",
  ];

  test("diagnostics work self-hosted and never leave the installation", async () => {
    // Reuse the core suite's Solo Desk product (self-hosted serves exactly
    // one Workspace; registration is closed).
    test.skip(!productKey, "core onboarding did not run");
    await agentPage.goto("/settings/products");
    await agentPage
      .locator('a[href^="/settings/products/"]')
      .filter({ hasText: "Solo Desk" })
      .first()
      .click();
    await expect(agentPage).toHaveURL(/\/settings\/products\/[^/]+/u);
    const productId = agentPage.url().match(/\/settings\/products\/([^/?]+)/u)?.[1] ?? "";
    expect(productId).not.toBe("");
    await enableDiagnostics(agentPage, productId);

    const page = await customerContext.newPage();
    const widgetHosts = new Set<string>();
    const otherHosts = new Set<string>();
    page.on("request", (request) => {
      const url = new URL(request.url());
      const isWidgetSurface =
        url.pathname.startsWith("/api/widget") ||
        url.pathname === "/widget.js" ||
        url.pathname === "/widget-diagnostics.js" ||
        url.pathname === "/widget";
      if (isWidgetSurface) widgetHosts.add(url.origin);
      // 127.0.0.1:9 is the diag page's own deliberately-unreachable request.
      else if (url.origin !== "http://localhost:3101" && url.origin !== APP && url.origin !== "http://127.0.0.1:9")
        otherHosts.add(url.origin);
    });
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/widget/messages") && request.method() === "POST") {
        posts.push(request.postData() ?? "");
      }
    });

    await page.goto(`${diagHostPageFor(APP)}&key=${encodeURIComponent(productKey)}`);
    await page.waitForFunction(() => Boolean((window as { __ssDiag?: unknown }).__ssDiag), undefined, {
      timeout: 15_000,
    });
    await page.evaluate(() => (window as { __triggerDiag?: () => void }).__triggerDiag?.());
    await page.waitForFunction(
      () =>
        (window as unknown as Record<string, unknown>).__fetchStatus === 500 &&
        (window as unknown as Record<string, unknown>).__xhrStatus === 500 &&
        (window as unknown as Record<string, unknown>).__unreachableFailed === true &&
        (window as unknown as Record<string, unknown>).__threw === true,
    );
    await page.waitForTimeout(150);

    const frame = page.frameLocator("#supportseal-widget-host iframe");
    await page.locator("#supportseal-widget-host button").first().click();
    await expect(frame.locator("#statusline")).toContainText("Online");
    await expect(frame.locator("#diagNotice")).toContainText(/Technical details from this page/u);
    await frame.locator("#input").fill("Self-hosted diagnostics message 5ce9");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Self-hosted diagnostics message 5ce9");

    expect(posts).toHaveLength(1);
    for (const canary of CANARIES) {
      expect(posts[0], `canary leaked: ${canary}`).not.toContain(canary);
    }
    const payload = JSON.parse(posts[0]) as { diagnostics?: { events: Array<{ kind: string }> } };
    expect(payload.diagnostics?.events?.map((event) => event.kind)).toContain("js_error");

    // Every widget/diagnostics request targeted the installation itself.
    expect([...widgetHosts]).toEqual([APP]);
    expect([...otherHosts]).toEqual([]);
    await page.close();
  });

  test("agent sees the diagnostics chip and sheet", async () => {
    test.skip(!productKey, "core onboarding did not run");
    await agentPage.goto("/inbox");
    // The earlier agent reply left this visitor's conversation Pending.
    await agentPage.getByRole("tab", { name: /^Pending/u }).click();
    const row = agentPage
      .locator("ul[aria-label='Conversations'] li a")
      .filter({ hasText: "Self-hosted diagnostics message 5ce9" });
    await expect(row).toBeVisible();
    await row.click();
    const chip = agentPage.getByRole("button", { name: /^Diagnostics for this message:/u });
    await expect(chip).toBeVisible();
    await chip.click();
    const sheet = agentPage.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Browser");
    await expect(sheet).toContainText("Values that look like secrets, emails or tokens were removed.");
  });

  // Regression (#140): the Team page overflowed its card at phone width.
  test("team page fits a 390px viewport (members, invite form, invites)", async () => {
    test.skip(!productKey, "core onboarding did not run");
    await agentPage.setViewportSize({ width: 390, height: 844 });
    await agentPage.goto("/settings/team");

    const email = agentPage.getByLabel("Email");
    await expect(email).toBeVisible();
    await email.fill(
      `a-very-long-invitee-address.with.many.parts.${Date.now()}@subdomain.long-company-domain.example.org`,
    );
    await agentPage.getByRole("button", { name: "Create invite" }).click();
    await expect(agentPage.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(agentPage.getByRole("button", { name: "Revoke" }).first()).toBeVisible();

    const { scrollWidth, clientWidth } = await agentPage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    for (const locator of [
      agentPage.getByLabel("Email"),
      agentPage.getByLabel("Role"),
      agentPage.getByRole("button", { name: "Create invite" }),
      agentPage.getByRole("button", { name: "Copy" }),
      agentPage.getByRole("button", { name: "Revoke" }).first(),
    ]) {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(clientWidth);
    }
  });
});
