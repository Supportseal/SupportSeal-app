import { expect, test, type BrowserContext, type Browser, type Page, type Response } from "@playwright/test";

import { loadFixtures, openWidget, signIn } from "./helpers";

/**
 * Third-party embed behaviour (issue #56): when the widget iframe is served
 * by the app but embedded on a customer origin, browsers may block its
 * third-party cookies entirely (Safari ITP, Firefox ETP, Chrome with
 * third-party cookie blocking). The panel must then keep working through the
 * stored visitor token — messages via the x-ss-visitor-token header and the
 * SSE stream via the t= query parameter — and the bounded polling fallback
 * (ADR-0003) must deliver replies when the stream cannot connect at all.
 *
 * The customer page runs on the support origin (a different port than the
 * app), and the visitor cookie is kept out of every widget API request —
 * see cookieBlockedContext() below for how the cookieless path is enforced
 * (a plain header strip is not enough: Chromium attaches jar cookies after
 * route interception, and current builds store the Secure/Partitioned
 * visitor cookie on http://localhost).
 */
test.describe("widget in a third-party iframe", () => {
  const fixtures = loadFixtures();
  const betaKey = fixtures.beta.product.key;

  let browser: Browser;
  let ownerPage: Page;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    ownerPage = await ownerContext.newPage();
    await signIn(ownerPage, fixtures.beta.owner.email, fixtures.beta.owner.password);
  });

  test.afterAll(async () => {
    await ownerPage?.context().close();
  });

  /**
   * Context whose widget API requests go out without cookies (3P blocked).
   *
   * Chromium attaches cookies from the context jar after route interception,
   * so deleting the Cookie header via route.continue is not enough on its
   * own (and a proxied session response still lands its Set-Cookie in the
   * jar). The jar itself is therefore kept empty — every widget request
   * first drops any stored cookie, then continues header-stripped. What is
   * left is exactly the Safari-ITP scenario the spec needs: the session
   * boot succeeds (token in the JSON body) but no cookie transport ever
   * exists, so the stored token is the visitor's only credential.
   */
  async function cookieBlockedContext(): Promise<BrowserContext> {
    const context = await browser.newContext();
    await context.route("**/api/widget/**", async (route) => {
      await context.clearCookies();
      const headers = { ...route.request().headers() };
      delete headers.cookie;
      await route.continue({ headers });
    });
    return context;
  }

  test("stream connects without third-party cookies and delivers agent replies live (#56)", async () => {
    const context = await cookieBlockedContext();
    const customerPage = await context.newPage();
    // Order-agnostic stream observation: records every stream response the
    // page sees, so assertions never race the panel's stream lifecycle.
    const streams: Array<{ url: string; status: number; response: Response }> = [];
    customerPage.on("response", (response) => {
      if (new URL(response.url()).pathname !== "/api/widget/stream") return;
      streams.push({
        url: response.request().url(),
        status: response.status(),
        response,
      });
    });

    const marker = `Live reply probe ${Date.now().toString(36)}`;
    const frame = await openWidget(customerPage, betaKey, { status: "Online" });

    // No conversation yet, so no stream attempt at all (#190).
    expect(streams).toEqual([]);

    // Messages already work header-token authenticated; the regression is
    // the stream: it must connect via t= without any cookie.
    await frame.locator("#input").fill(marker);
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText(marker);
    await expect
      .poll(
        () => streams.some((s) => s.status === 200 && s.url.includes("&t=")),
        { timeout: 20_000 },
      )
      .toBe(true);

    const ok = streams.find((s) => s.status === 200)!;
    expect(ok.response.headers()["content-type"]).toContain("text/event-stream");
    // The stream request that succeeded went out without a visitor cookie —
    // the t= token was the only credential on it.
    const streamHeaders = await ok.response.request().allHeaders();
    expect(streamHeaders.cookie ?? "").not.toContain("ss_visitor_");

    // Agent replies; the open widget receives it without any reload.
    const reply = `Third-party live reply ${Date.now().toString(36)}`;
    await ownerPage.goto("/inbox");
    const row = ownerPage
      .locator('ul[aria-label="Conversations"] li a')
      .filter({ hasText: marker })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await ownerPage.getByLabel(/^Reply to /u).fill(reply);
    await ownerPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      ownerPage.getByRole("article").filter({ hasText: reply }).first(),
    ).toBeVisible();
    await customerPage.bringToFront();
    await expect(frame.locator("#thread")).toContainText(reply, { timeout: 20_000 });
    await context.close();
  });

  test("polling fallback delivers replies while the stream cannot connect", async () => {
    const context = await cookieBlockedContext();
    // Registered later, so it wins for the stream: every attempt fails with
    // an HTTP error, which permanently closes the EventSource (the retry
    // storm of network-level failures is issue #57, out of scope here).
    // The stream only opens after the first send (#190), so polling starts
    // only once its retries are exhausted, ~14 s after that send.
    test.setTimeout(90_000);
    await context.route("**/api/widget/stream*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "text/plain",
        body: "simulated stream failure",
      }),
    );
    const customerPage = await context.newPage();
    // Prove the 500-fulfilment actually won: no stream response may succeed.
    const streamStatuses: number[] = [];
    customerPage.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/widget/stream") {
        streamStatuses.push(response.status());
      }
    });

    const marker = `Fallback probe ${Date.now().toString(36)}`;
    const frame = await openWidget(customerPage, betaKey, { status: "Online" });
    await frame.locator("#input").fill(marker);
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText(marker);

    const reply = `Fallback reply ${Date.now().toString(36)}`;
    await ownerPage.goto("/inbox");
    const row = ownerPage
      .locator('ul[aria-label="Conversations"] li a')
      .filter({ hasText: marker })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await ownerPage.getByLabel(/^Reply to /u).fill(reply);
    await ownerPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      ownerPage.getByRole("article").filter({ hasText: reply }).first(),
    ).toBeVisible();

    // No stream ever established (every attempt got 500); the reply still
    // arrives through the bounded polling fallback. The poll only runs
    // while the page is visible, so bring the customer page back to front.
    await customerPage.bringToFront();
    await expect(frame.locator("#thread")).toContainText(reply, { timeout: 45_000 });
    expect(streamStatuses.length).toBeGreaterThan(0);
    expect(streamStatuses).not.toContain(200);
    await context.close();
  });
});
