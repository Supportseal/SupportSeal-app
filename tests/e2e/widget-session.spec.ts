import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  hostPageFor,
  onboardWorkspaceWithProduct,
  openWidget,
  uniqueAccount,
  widgetFrame,
  APP_ORIGIN,
  SUPPORT_ORIGIN_ALT,
} from "./helpers";

/**
 * Visitor session stickiness (issue #61): visitor identity follows the
 * visitor token alone. A session never resurfaces on a different origin
 * (cookies and storage partition keys ignore ports, so "another port of the
 * same host" must not resume it), clearing the client's cookies and storage
 * yields a fresh anonymous visitor with the away form reachable, and
 * identify() enriches the current session without resurrecting history.
 */
test.describe.serial("visitor session stickiness", () => {
  const account = uniqueAccount();
  const product = { name: "Sticky Desk", domain: "sticky.desk.test" };

  let agentPage: Page;
  let customerContext: BrowserContext;
  let customerPage: Page;
  let productKey = "";

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();
    customerContext = await browser.newContext();
    productKey = await onboardWorkspaceWithProduct(agentPage, account, product);
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await customerContext?.close();
  });

  /** The reporter's setup: the host page pushes identify() on every load. */
  function identifiedHostPage(supportOrigin?: string): string {
    const base = hostPageFor(APP_ORIGIN, supportOrigin);
    return `${base}&identify=1`;
  }

  test("an identified visitor chats and resumes in the same browser (FR-CHAT-02)", async () => {
    customerPage = await customerContext.newPage();
    const identified = customerPage.waitForResponse(
      (response) => response.url().includes("/api/widget/context") && response.status() === 200,
      { timeout: 20_000 },
    );
    const frame = await openWidget(customerPage, productKey, {
      status: "Online",
      hostPage: identifiedHostPage(),
    });
    // identify() must have enriched the session before the message creates
    // the contact (name shown in the inbox assertions below).
    await identified;
    await frame.locator("#input").fill("Beta question: does the API rate limit?");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Beta question");

    // Same browser, same origin: a reload keeps the conversation.
    await customerPage.reload();
    const reopened = await openWidget(customerPage, productKey, { status: "Online" });
    await expect(reopened.locator("#thread")).toContainText("Beta question");
  });

  test("a different port of the same host gets a fresh session, not the old thread", async () => {
    // Cookies (and their partition keys) ignore ports, so the visitor
    // credential from :3101 is still presented to the widget on :3102 — it
    // must not resume the conversation bound to the other origin.
    const portPage = await customerContext.newPage();
    const frame = await openWidget(portPage, productKey, {
      status: "Online",
      hostPage: identifiedHostPage(SUPPORT_ORIGIN_ALT),
    });
    await expect(frame.locator("#thread")).not.toContainText("Beta question");
    await expect(frame.locator("#thread")).toContainText("Ask us anything");
    await portPage.close();
  });

  test("clearing only the cookie does not resurrect the session from the iframe fallback", async () => {
    // The reporter's exact partial clear (#61): the visitor cookie and the
    // host page's storage are cleared, but the widget iframe's partitioned
    // sessionStorage — where the panel keeps its Safari-ITP fallback token —
    // is invisible to that clear. The fallback must have been dropped
    // already (the cookie transport provably works in this browser), so the
    // next load starts a fresh session instead of restoring the thread.
    await customerContext.clearCookies();
    await customerPage.evaluate(() => {
      try {
        localStorage.clear();
      } catch {
        /* storage blocked */
      }
    });
    await customerPage.reload();
    const frame = await openWidget(customerPage, productKey, {
      status: "Online",
      hostPage: identifiedHostPage(),
    });
    await expect(frame.locator("#thread")).not.toContainText("Beta question");
    await expect(frame.locator("#thread")).toContainText("Ask us anything");
  });

  test("cleared client state yields a fresh anonymous visitor and a reachable away form", async () => {
    // Support goes Away (the reporter's away-capture scenario), then the
    // visitor clears every client credential: cookies, host-page storage and
    // the widget iframe's partitioned sessionStorage.
    await agentPage.goto("/inbox");
    const availability = agentPage.getByRole("radiogroup", { name: "Support availability" });
    const away = availability.getByRole("radio", { name: "Away" });
    await away.click();
    await expect(away).toBeChecked();
    // The selection is optimistic; wait until the server change has settled.
    await expect(availability).toHaveAttribute("aria-busy", "false");
    await expect(away).toBeChecked();

    await customerContext.clearCookies();
    for (const page of customerContext.pages()) {
      await page.evaluate(() => {
        try {
          localStorage.clear();
        } catch {
          /* storage blocked */
        }
      });
      const widgetFrame = page.frames().find((f) => f.url().includes("/widget?"));
      if (widgetFrame) {
        await widgetFrame.evaluate(() => {
          try {
            sessionStorage.clear();
          } catch {
            /* storage blocked */
          }
        });
      }
    }

    // Reload on the identified host page: the previous conversation and its
    // email state must NOT come back even though identify() runs again — a
    // fresh anonymous session starts and the away form (unreachable in the
    // bug) shows.
    const frame = await openWidget(customerPage, productKey, {
      status: "Away",
      hostPage: identifiedHostPage(),
    });
    await expect(frame.locator("#thread")).not.toContainText("Beta question");
    await expect(frame.locator("#away")).toBeVisible();
    await expect(frame.locator("#message")).toBeVisible();

    // The away form works for the genuinely new visitor.
    await frame.locator("#email").fill("fresh-visitor@e2e.test");
    await frame.locator("#message").fill("Fresh visitor after clearing my data.");
    await frame.locator("#awaySend").click();
    await expect(frame.locator("#thread")).toContainText("Fresh visitor after clearing my data.");
  });

  test("the away-form message landed in its own new conversation", async () => {
    await agentPage.goto("/inbox");
    const rows = agentPage.locator('ul[aria-label="Conversations"] li a');
    // The fresh visitor's away-form message is its own conversation…
    await expect(rows.filter({ hasText: "Fresh visitor after clearing my data." })).toHaveCount(1);
    // …separate from the original thread. (Both rows may show the
    // identified label: the host page pushes identify() onto every session,
    // including the fresh one — enrichment, not resurrection.)
    await expect(rows.filter({ hasText: "Beta question" })).toHaveCount(1);
    await expect(rows).toHaveCount(2);
  });
});

/**
 * Host sign-out (issue #151): SupportSealWidget.reset() ends the visitor
 * session so the next user on a shared device does not resume the previous
 * user's thread or identity.
 */
test.describe.serial("widget reset on host sign-out (issue #151)", () => {
  const account = uniqueAccount();
  const product = { name: "Shared Desk", domain: "shared.desk.test" };

  let agentPage: Page;
  let customerContext: BrowserContext;
  let customerPage: Page;
  let productKey = "";

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();
    customerContext = await browser.newContext();
    productKey = await onboardWorkspaceWithProduct(agentPage, account, product);
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await customerContext?.close();
  });

  test("reset() drops the previous user's thread and identity, and it stays gone after a reload", async () => {
    customerPage = await customerContext.newPage();
    const frame = await openWidget(customerPage, productKey, {
      status: "Online",
      hostPage: `${hostPageFor(APP_ORIGIN)}&identify=1`,
    });
    await frame.locator("#input").fill("Shared device question from user A");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Shared device question from user A");
    await expect(frame.locator("#thread")).toContainText("identified@e2e.test");

    // The host app signs user A out, then user B signs in on the same browser.
    const revoked = customerPage.waitForResponse(
      (response) =>
        response.url().includes("/api/widget/session") &&
        response.request().method() === "DELETE" &&
        response.status() === 204,
      { timeout: 20_000 },
    );
    await customerPage.evaluate(() => {
      const widget = (window as unknown as {
        SupportSealWidget: { reset(): void; identify(payload: object): void };
      }).SupportSealWidget;
      widget.reset();
      widget.identify({ userId: "e2e-user-b", email: "user-b@e2e.test", name: "User B" });
    });
    await revoked;

    await expect(frame.locator("#thread")).not.toContainText("Shared device question from user A");
    await expect(frame.locator("#thread")).not.toContainText("identified@e2e.test");
    await expect(frame.locator("#thread")).toContainText("Ask us anything");

    // A reload resumes the fresh session, not the signed-out user's.
    await customerPage.reload();
    const reopened = await openWidget(customerPage, productKey, { status: "Online" });
    await expect(reopened.locator("#thread")).not.toContainText("Shared device question from user A");
    await expect(reopened.locator("#thread")).toContainText("Ask us anything");
  });

  test("user B's identity lands on a fresh visitor, separate from user A's conversation", async () => {
    const frame = widgetFrame(customerPage);
    await frame.locator("#input").fill("Question from user B");
    await frame.locator("#send").click();
    await expect(frame.locator("#thread")).toContainText("Question from user B");

    await agentPage.goto("/inbox");
    const rows = agentPage.locator('ul[aria-label="Conversations"] li a');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Shared device question from user A" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Question from user B" })).toHaveCount(1);
  });
});
