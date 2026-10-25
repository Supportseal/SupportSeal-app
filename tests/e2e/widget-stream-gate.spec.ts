import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

import { loadFixtures, openWidget } from "./helpers";

/**
 * Issue #190: a visitor with no conversation must not open the SSE stream.
 * The server answers /api/widget/stream with 401 until a conversation exists,
 * so opening it on every page view put a red console error (and a retry /
 * polling chain) on every customer site. The stream opens once the visitor
 * has a conversation: after the first send, or when a stored session is
 * restored on a later page load.
 */
test.describe("widget stream gate (#190)", () => {
  const fixtures = loadFixtures();
  const betaKey = fixtures.beta.product.key;

  function watch(page: Page) {
    const streams: string[] = [];
    const messagePolls: string[] = [];
    const failedLoads: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/widget/stream") streams.push(request.url());
      if (url.pathname === "/api/widget/messages" && request.method() === "GET") {
        messagePolls.push(request.url());
      }
    });
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() === "error" && /\b401\b/u.test(message.text())) {
        failedLoads.push(message.text());
      }
    });
    return { streams, messagePolls, failedLoads };
  }

  test("a fresh visitor makes no stream or polling requests; the stream opens on first send and on restore", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const seen = watch(page);

    const frame = await openWidget(page, betaKey, { status: "Online" });
    // Boot makes one cookie-transport probe GET on /messages; nothing recurs.
    // The stream attempt used to fire at once and retry at 2 s / 4 s / 8 s,
    // so give the first retry window time to show.
    const probes = seen.messagePolls.length;
    expect(probes).toBeLessThanOrEqual(1);
    await page.waitForTimeout(5000);
    expect(seen.streams).toEqual([]);
    expect(seen.messagePolls).toHaveLength(probes);
    expect(seen.failedLoads).toEqual([]);

    const marker = `Stream gate probe ${Date.now().toString(36)}`;
    await frame.locator("#input").fill(marker);
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText(marker);
    await expect.poll(() => seen.streams.length, { timeout: 20_000 }).toBe(1);
    expect(seen.failedLoads).toEqual([]);

    // A stored session with a conversation opens the stream without a send.
    const restored = await context.newPage();
    const afterRestore = watch(restored);
    const restoredFrame = await openWidget(restored, betaKey, { status: "Online" });
    await expect(restoredFrame.locator("#thread")).toContainText(marker);
    await expect.poll(() => afterRestore.streams.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(afterRestore.failedLoads).toEqual([]);
    await context.close();
  });

  test("a 401 on a restored visitor's stream backs off and gives up instead of hot-looping", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext();
    const first = await context.newPage();
    const frame = await openWidget(first, betaKey, { status: "Online" });
    const marker = `Stream 401 probe ${Date.now().toString(36)}`;
    await frame.locator("#input").fill(marker);
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText(marker);

    await context.route("**/api/widget/stream*", (route) =>
      route.fulfill({ status: 401, contentType: "text/plain", body: "no session" }),
    );
    const page = await context.newPage();
    const seen = watch(page);
    await openWidget(page, betaKey, { status: "Online" });
    // One attempt plus three jittered backoff retries (2 s / 4 s / 8 s, up to
    // 1.5x) then polling takes over; a hot loop would blow far past this.
    await page.waitForTimeout(30_000);
    expect(seen.streams.length).toBeGreaterThanOrEqual(1);
    expect(seen.streams.length).toBeLessThanOrEqual(4);
    await context.close();
  });
});
