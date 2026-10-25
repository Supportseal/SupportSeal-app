import { expect, test, type BrowserContext, type Frame, type Page } from "@playwright/test";

import { HOST_PAGE, onboardWorkspaceWithProduct, uniqueAccount, widgetFrame } from "./helpers";

/**
 * Issue #125: incoming-message chime on the desk (visitor message) and in the
 * widget (agent reply). Chromium has no audio sink in CI, so each page gets a
 * stub AudioContext that counts scheduled oscillators (two per chime) — the
 * real synthesis code still runs against the stub.
 */
const COUNT_CHIMES = `
  (() => {
    class StubAudioContext {
      constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createGain() {
        const p = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
        return { gain: p, connect() {} };
      }
      createOscillator() {
        window.__oscillators = (window.__oscillators || 0) + 1;
        return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
      }
    }
    window.AudioContext = StubAudioContext;
  })();
`;

async function chimes(target: Page | Frame): Promise<number> {
  return target.evaluate(() => Math.floor(((window as unknown as { __oscillators?: number }).__oscillators ?? 0) / 2));
}

test.describe.serial("incoming message sound", () => {
  const account = uniqueAccount();
  const product = { name: "Chime Desk", domain: "chime.desk.test" };

  let agentPage: Page;
  let customerContext: BrowserContext;
  let customerPage: Page;
  let productKey = "";
  const pageErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await agentContext.addInitScript(COUNT_CHIMES);
    agentPage = await agentContext.newPage();
    customerContext = await browser.newContext();
    await customerContext.addInitScript(COUNT_CHIMES);
    customerPage = await customerContext.newPage();
    for (const page of [agentPage, customerPage]) {
      page.on("pageerror", (error) => pageErrors.push(error.message));
    }
    productKey = await onboardWorkspaceWithProduct(agentPage, account, product);
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await customerContext?.close();
  });

  function panel(): Frame {
    const frame = customerPage.frames().find((f) => new URL(f.url()).pathname === "/widget");
    if (!frame) throw new Error("widget panel frame not found");
    return frame;
  }

  async function visitorSays(text: string) {
    const frame = widgetFrame(customerPage);
    await frame.locator("#input").fill(text);
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText(text, { timeout: 20_000 });
  }

  async function agentReply(text: string) {
    const send = agentPage.getByRole("button", { name: "Send", exact: true });
    await expect(async () => {
      await agentPage.getByLabel(/^Reply to /u).fill(text);
      await expect(send).toBeEnabled({ timeout: 1000 });
    }).toPass();
    await send.click();
    await expect(agentPage.getByRole("article").filter({ hasText: text }).first()).toBeVisible();
  }

  async function messageSoundItem() {
    const item = agentPage.getByRole("menuitemcheckbox", { name: "Message sound" });
    // A click that lands before hydration never opens the menu; retry it.
    await expect(async () => {
      await agentPage.keyboard.press("Escape");
      await agentPage.getByRole("button", { name: "Account menu" }).click();
      await expect(item).toBeVisible({ timeout: 2_000 });
    }).toPass();
    return item;
  }

  test("desk chimes for a visitor message but not for the agent's own reply", async () => {
    test.setTimeout(120_000);
    await agentPage.goto("/inbox");
    await expect(agentPage.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
    // The feed baseline must exist before the visitor writes.
    await agentPage.waitForResponse((r) => new URL(r.url()).pathname === "/api/inbox/notifications");

    await customerPage.goto(`${HOST_PAGE}&key=${encodeURIComponent(productKey)}`);
    await customerPage.locator("#supportseal-widget-host button").first().click();
    await expect(widgetFrame(customerPage).locator("#statusline")).toContainText("Online");
    await visitorSays("Hi, is there a student discount?");

    await expect.poll(() => chimes(agentPage), { timeout: 30_000 }).toBe(1);

    await agentPage.locator('ul[aria-label="Conversations"] li a').first().click();
    await expect(agentPage).toHaveURL(/\/inbox\/[^/]+\/?$/u);
    await agentReply("Yes, 20% off for students.");

    // The widget (a different surface) chimes for that very reply...
    await expect.poll(() => chimes(panel()), { timeout: 30_000 }).toBe(1);
    // ...while the desk stays quiet for its own message.
    await agentPage.waitForTimeout(3_000);
    expect(await chimes(agentPage)).toBe(1);
  });

  test("the visitor's own message never chimes the widget", async () => {
    await visitorSays("Great, thanks!");
    await customerPage.waitForTimeout(3_000);
    expect(await chimes(panel())).toBe(1);
  });

  test("desk mute toggle silences visitor messages and persists across reload", async () => {
    test.setTimeout(120_000);
    let item = await messageSoundItem();
    await expect(item).toHaveAttribute("aria-checked", "true");
    await item.click();
    await expect(item).toHaveAttribute("aria-checked", "false");
    await agentPage.keyboard.press("Escape");

    await agentPage.reload();
    item = await messageSoundItem();
    await expect(item).toHaveAttribute("aria-checked", "false");
    await agentPage.keyboard.press("Escape");

    await visitorSays("One more question about invoices.");
    await agentPage.waitForTimeout(4_000);
    expect(await chimes(agentPage)).toBe(0); // fresh page after reload, still muted
  });

  test("widget mute toggle persists across reload and silences agent replies", async () => {
    test.setTimeout(120_000);
    const sound = widgetFrame(customerPage).locator("#soundBtn");
    await expect(sound).toHaveAttribute("aria-label", "Mute message sound");
    await sound.click();
    await expect(sound).toHaveAttribute("aria-label", "Unmute message sound");

    await customerPage.reload();
    await customerPage.locator("#supportseal-widget-host button").first().click();
    await expect(widgetFrame(customerPage).locator("#statusline")).toContainText("Online");
    await expect(widgetFrame(customerPage).locator("#soundBtn")).toHaveAttribute(
      "aria-label",
      "Unmute message sound",
    );

    await agentReply("Invoices are under Billing > History.");
    await expect(widgetFrame(customerPage).locator(".msg.agent").last()).toContainText("Billing > History", {
      timeout: 30_000,
    });
    await customerPage.waitForTimeout(2_000);
    expect(await chimes(panel())).toBe(0);
  });

  test("no page errors were raised by the sound code", () => {
    expect(pageErrors).toEqual([]);
  });
});
