import zlib from "node:zlib";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  APP_ORIGIN,
  createProduct,
  diagHostPageFor,
  disableDiagnostics,
  enableDiagnostics,
  loadFixtures,
  signIn,
} from "./helpers";

/**
 * Browser diagnostics V2 end to end (docs/design/diagnostics.md, DX-01,
 * DX-03, DX-04, DX-08, DX-09, DX-14, DX-15, DX-16, DX-17).
 */
const CANARIES = [
  "CANARY_COOKIE",
  "CANARY_STORAGE",
  "CANARY_SESSION",
  "CANARY_PASSWORD",
  "CANARY_AUTH",
  "CANARY_BODY",
  "CANARY_LOG",
];

type CapturedPost = { body: string; response: unknown };

test.describe.serial("browser diagnostics", () => {
  const fixtures = loadFixtures();

  let ownerPage: Page;
  let customerContext: BrowserContext;
  let diagProduct: { id: string; key: string };

  /** Open the diagnostics host page and wait for the widget + collector. */
  async function openDiagPage(key: string, expectCollector: boolean) {
    const page = await customerContext.newPage();
    const collectorRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/widget-diagnostics.js")) collectorRequests.push(request.url());
    });
    await page.goto(`${diagHostPageFor(APP_ORIGIN)}&key=${encodeURIComponent(key)}`);
    await expect(page.locator("#supportseal-widget-host")).toBeAttached();
    if (expectCollector) {
      await page.waitForFunction(
        () => Boolean((window as { __ssDiag?: unknown }).__ssDiag),
        undefined,
        { timeout: 15_000 },
      );
    } else {
      await page.waitForTimeout(1500);
    }
    return { page, collectorRequests };
  }

  /** Trigger all capture kinds and wait until they settled. */
  async function triggerDiag(page: Page) {
    await page.evaluate(() => {
      (window as { __triggerDiag?: () => void }).__triggerDiag?.();
    });
    await page.waitForFunction(
      () =>
        (window as unknown as Record<string, unknown>).__fetchStatus === 500 &&
        (window as unknown as Record<string, unknown>).__xhrStatus === 500 &&
        (window as unknown as Record<string, unknown>).__unreachableFailed === true &&
        (window as unknown as Record<string, unknown>).__threw === true,
    );
    // The rejection and the thrown error arrive on microtask/macrotask queues.
    await page.waitForTimeout(150);
  }

  function captureMessagePosts(page: Page) {
    const posts: CapturedPost[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/widget/messages") && request.method() === "POST") {
        posts.push({ body: request.postData() ?? "", response: null });
      }
    });
    page.on("response", async (response) => {
      if (response.url().includes("/api/widget/messages") && response.request().method() === "POST") {
        try {
          posts[posts.length - 1]!.response = await response.json();
        } catch {
          /* ignore */
        }
      }
    });
    return posts;
  }

  test.beforeAll(async ({ browser }) => {
    const ownerContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    ownerPage = await ownerContext.newPage();
    await signIn(ownerPage, fixtures.beta.owner.email, fixtures.beta.owner.password);
    diagProduct = await createProduct(ownerPage, {
      name: "DiagProduct",
      domain: "localhost",
    });
    await enableDiagnostics(ownerPage, diagProduct.id);

    customerContext = await browser.newContext();
  });

  test.afterAll(async () => {
    await ownerPage?.context().close();
    await customerContext?.close();
  });

  test("DX-01: off by default — no collector request, no diagnostics payload", async () => {
    const { page, collectorRequests } = await openDiagPage(fixtures.beta.product.key, false);
    const posts = captureMessagePosts(page);
    await triggerDiag(page);

    const frame = await (async () => {
      const locator = page.locator("#supportseal-widget-host button").first();
      await expect(locator).toBeVisible();
      await locator.click();
      return page.frameLocator("#supportseal-widget-host iframe");
    })();
    await expect(frame.locator("#statusline")).toContainText("Online");
    await frame.locator("#input").fill("Message without diagnostics dx01");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Message without diagnostics dx01");

    expect(collectorRequests).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(Object.hasOwn(JSON.parse(posts[0]!.body), "diagnostics")).toBe(false);
    await page.close();
  });

  test("DX-08: errors without a message produce no diagnostics request", async () => {
    const { page, collectorRequests } = await openDiagPage(diagProduct.key, true);
    const posts = captureMessagePosts(page);
    await triggerDiag(page);
    await page.waitForTimeout(1000);
    expect(collectorRequests).toHaveLength(1); // the collector bundle itself
    expect(posts).toHaveLength(0); // no message POST, no conversation
    await page.close();
  });

  test("DX-03/DX-04: capture allowlist respected, canaries never sent", async () => {
    const { page } = await openDiagPage(diagProduct.key, true);
    const posts = captureMessagePosts(page);
    await triggerDiag(page);

    const frame = page.frameLocator("#supportseal-widget-host iframe");
    await page.locator("#supportseal-widget-host button").first().click();
    await expect(frame.locator("#statusline")).toContainText("Online");
    // The widget notice line is visible while diagnostics are enabled.
    await expect(frame.locator("#diagNotice")).toContainText(/Technical details from this page/u);
    await frame.locator("#input").fill("It broke after the update dx03");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("It broke after the update dx03");
    await expect(posts).toHaveLength(1);

    const raw = posts[0]!.body;
    for (const canary of CANARIES) {
      expect(raw, `canary leaked: ${canary}`).not.toContain(canary);
    }

    const payload = JSON.parse(raw) as {
      diagnostics: {
        environment: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };
    };
    expect(payload.diagnostics).toBeTruthy();
    expect(payload.diagnostics.environment.pageUrl).toBe(`${"http://localhost:3101"}/`);
    expect(payload.diagnostics.environment.viewportWidth).toBeGreaterThan(0);

    const kinds = payload.diagnostics.events.map((event) => event.kind).sort();
    expect(kinds).toEqual(["js_error", "network", "network", "promise_rejection", "warning", "warning"]);

    const network = payload.diagnostics.events.filter((event) => event.kind === "network");
    const failing = network.find((event) => event.status === 500);
    // The client sends the URL as the app wrote it; the server resolves it
    // against the page (asserted in the agent view below).
    expect(failing?.url).toBe("/_diag/fail");
    expect(failing?.count).toBe(2); // fetch + XHR deduped
    expect(network.some((event) => event.status === 0)).toBe(true);

    const rejection = payload.diagnostics.events.find((event) => event.kind === "promise_rejection");
    // Client-side redaction already removed the secret from the message.
    expect(rejection?.message).toContain("password=[redacted]");

    const thrown = payload.diagnostics.events.find((event) => event.kind === "js_error");
    expect(thrown?.message).toContain("<img src=x");
    await page.close();
  });

  test("DX-15: diagnostics(false) pauses and clears; diagnostics(true) resumes", async () => {
    const { page } = await openDiagPage(diagProduct.key, true);
    const posts = captureMessagePosts(page);
    await page.evaluate(() => {
      (window as { SupportSealWidget?: { diagnostics: (v: boolean) => void } }).SupportSealWidget?.diagnostics(false);
    });
    await triggerDiag(page);

    const frame = page.frameLocator("#supportseal-widget-host iframe");
    await page.locator("#supportseal-widget-host button").first().click();
    await expect(frame.locator("#statusline")).toContainText("Online");
    await frame.locator("#input").fill("Paused message dx15a");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Paused message dx15a");
    expect(posts).toHaveLength(1);
    expect(Object.hasOwn(JSON.parse(posts[0]!.body), "diagnostics")).toBe(false);

    await page.evaluate(() => {
      (window as { SupportSealWidget?: { diagnostics: (v: boolean) => void } }).SupportSealWidget?.diagnostics(true);
    });
    await triggerDiag(page);
    // The server spaces visitor messages by at least 800 ms.
    await page.waitForTimeout(1200);
    await frame.locator("#input").fill("Resumed message dx15b");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Resumed message dx15b");
    expect(posts).toHaveLength(2);
    expect(Object.hasOwn(JSON.parse(posts[1]!.body), "diagnostics")).toBe(true);
    await page.close();
  });

  test("DX-09: a broken collector never blocks the message", async () => {
    const { page } = await openDiagPage(diagProduct.key, true);
    await page.evaluate(() => {
      const collector = (window as { __ssDiag?: { snapshot: () => unknown } }).__ssDiag;
      if (collector) collector.snapshot = () => {
        throw new Error("collector is broken");
      };
    });
    const posts = captureMessagePosts(page);
    await triggerDiag(page);

    const frame = page.frameLocator("#supportseal-widget-host iframe");
    await page.locator("#supportseal-widget-host button").first().click();
    await expect(frame.locator("#statusline")).toContainText("Online");
    await frame.locator("#input").fill("Broken collector dx09");
    const started = Date.now();
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Broken collector dx09");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(posts).toHaveLength(1);
    await page.close();
  });

  test("DX-14: disabling stops ingestion and the next collector load", async () => {
    const { page } = await openDiagPage(diagProduct.key, true);
    const posts = captureMessagePosts(page);
    await triggerDiag(page);
    await disableDiagnostics(ownerPage, diagProduct.id);

    const frame = page.frameLocator("#supportseal-widget-host iframe");
    await page.locator("#supportseal-widget-host button").first().click();
    await expect(frame.locator("#statusline")).toContainText("Online");
    await frame.locator("#input").fill("After disable dx14");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("After disable dx14");
    await expect(posts).toHaveLength(1);
    // The panel attached a snapshot but the server rejected it (disabled);
    // the response says so and nothing is stored.
    await expect
      .poll(async () => posts[0]?.response as { diagnostics?: { status?: string } } | null)
      .toMatchObject({ diagnostics: { status: "rejected" } });
    await page.close();

    // Next config load: the loader no longer fetches the collector bundle.
    const reloaded = await openDiagPage(diagProduct.key, false);
    await reloaded.page.waitForTimeout(1500);
    expect(reloaded.collectorRequests).toEqual([]);
    await reloaded.page.close();

    await enableDiagnostics(ownerPage, diagProduct.id);
  });

  test("DX-16: agent view — chip, section, sheet, literal text, copy", async () => {
    // Send one message with a known marker from the diag page.
    const { page } = await openDiagPage(diagProduct.key, true);
    await triggerDiag(page);
    const frame = page.frameLocator("#supportseal-widget-host iframe");
    await page.locator("#supportseal-widget-host button").first().click();
    await expect(frame.locator("#statusline")).toContainText("Online");
    await frame.locator("#input").fill("Agent view marker dx16-91f2");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Agent view marker dx16-91f2");
    await page.close();

    await ownerPage.goto("/inbox");
    const row = ownerPage
      .locator("ul[aria-label='Conversations'] li a")
      .filter({ hasText: "Agent view marker dx16-91f2" });
    await expect(row).toBeVisible();
    await row.click();

    // Message chip with counts (scoped to the marker's message bubble).
    const chip = ownerPage
      .locator("article")
      .filter({ hasText: "Agent view marker dx16-91f2" })
      .getByRole("button", { name: /^Diagnostics for this message:/u });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/error/u);

    // Context panel section (needs the xl aside).
    const section = ownerPage.locator("aside").filter({ hasText: "Diagnostics" }).first();
    await expect(section).toBeVisible();
    await expect(section).toContainText("Chrome");
    await expect(section).toContainText("Viewport");

    // Sheet: events, kind badges, literal rendering of the XSS payload.
    await chip.click();
    const sheet = ownerPage.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("POST http://localhost:3101/_diag/fail → 500");
    await expect(sheet).toContainText("Values that look like secrets, emails or tokens were removed.");
    // The hostile error message renders as literal text, never as markup.
    await expect(sheet.getByText("<img src=x onerror=window.__diagXss=1>", { exact: false })).toBeVisible();
    expect(await ownerPage.locator("img[src='x']").count()).toBe(0);

    await sheet.getByRole("button", { name: "Copy as text" }).click();
    await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
    const clipboard = await ownerPage.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("Diagnostics snapshot");
    expect(clipboard).toContain("[network] POST http://localhost:3101/_diag/fail → 500 ×2");
  });

  test("DX-17: loader <= 5 KB gzip, collector <= 4 KB gzip", async ({ request }) => {
    const loader = await request.get(`${APP_ORIGIN}/widget.js`);
    const collector = await request.get(`${APP_ORIGIN}/widget-diagnostics.js`);
    const loaderGzip = zlib.gzipSync(Buffer.from(await loader.text(), "utf8")).length;
    const collectorGzip = zlib.gzipSync(Buffer.from(await collector.text(), "utf8")).length;
    // Reported in the PR: loader {loaderGzip} B, collector {collectorGzip} B gzip.
    console.log(`[DX-17] loader ${loaderGzip} B gzip, collector ${collectorGzip} B gzip`);
    expect(loaderGzip).toBeLessThanOrEqual(5120);
    expect(collectorGzip).toBeLessThanOrEqual(4096);
  });
});
