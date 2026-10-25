import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  onboardWorkspaceWithProduct,
  openWidget,
  postInboundEmail,
  resetCapturedEmails,
  uniqueAccount,
  waitForEmail,
  type CapturedEmail,
} from "./helpers";

/**
 * Away mode and email continuation (FR-CHAT-04, FR-EMAIL-02): with support
 * Away the widget requires an email, the agent replies asynchronously, the
 * reply is delivered through the managed SMTP sender, and the customer's
 * emailed answer continues the SAME conversation via the reply+token path
 * (FR-EMAIL-01 threading evidence, never the subject).
 */
test.describe.serial("away mode and email continuation", () => {
  const account = uniqueAccount();
  const productName = "Away Desk";
  const visitorEmail = "pat@away.test";

  let agentPage: Page;
  let customerContext: BrowserContext;
  let customerPage: Page;
  let productKey = "";
  let outbound: CapturedEmail;
  let ticketRef = "";

  test.beforeAll(async ({ browser }) => {
    const agentContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    agentPage = await agentContext.newPage();
    customerContext = await browser.newContext();
  });

  test.afterAll(async () => {
    await agentPage?.context().close();
    await customerContext?.close();
  });

  test("owner switches support availability to Away", async () => {
    productKey = await onboardWorkspaceWithProduct(agentPage, account, {
      name: productName,
      domain: "away.desk.test",
    });

    await agentPage.goto("/inbox");
    const group = agentPage.getByRole("radiogroup", { name: "Support availability" });
    const live = group.getByRole("radio", { name: "Live" });
    const away = group.getByRole("radio", { name: "Away" });
    await expect(live).toBeChecked();
    await away.click();
    await expect(away).toBeChecked();
    await expect(live).not.toBeChecked();
    // The selection is optimistic; wait until the server change has settled.
    await expect(group).toHaveAttribute("aria-busy", "false");
    // A fresh load proves the server persisted Away, not just the optimistic UI.
    await agentPage.reload();
    await expect(away).toBeChecked();
    await expect(live).not.toBeChecked();
  });

  test("widget in away mode requires an email before submission", async ({ page }) => {
    const frame = await openWidget(page, productKey, { status: "Away" });
    await expect(frame.locator("#away")).toBeVisible();
    await expect(frame.locator("#input")).toBeHidden();

    await frame.locator("#message").fill("Message without an email should be rejected.");
    await frame.locator("#awaySend").click();
    await expect(frame.locator("#awayHint")).toContainText("Enter a valid email address");
  });

  test("visitor submits the away form and the agent sees the conversation", async () => {
    await resetCapturedEmails();
    customerPage = await customerContext.newPage();
    const frame = await openWidget(customerPage, productKey, { status: "Away" });

    await frame.locator("#email").fill(visitorEmail);
    await frame.locator("#message").fill("My March invoice is missing the GST line.");
    await frame.locator("#awaySend").click();
    await expect(frame.locator("#thread")).toContainText("missing the GST line");

    await agentPage.goto("/inbox");
    const row = agentPage.locator('ul[aria-label="Conversations"] li a').first();
    await expect(row).toContainText(visitorEmail);
    await row.click();
    await expect(agentPage.getByText("missing the GST line").first()).toBeVisible();

    // Ticket number (issue #141): one reference, shown to the customer in the
    // widget thread and to the agent in the desk header and list row.
    ticketRef = (await agentPage.getByTestId("ticket-ref").innerText()).trim();
    expect(ticketRef).toMatch(/^SS-\d+$/u);
    await expect(frame.locator("#ticketRef")).toHaveText(`Reference ${ticketRef}`);
    await expect(row).toContainText(ticketRef);
    await expect(
      agentPage.getByRole("article").filter({ hasText: "missing the GST line" })
        .getByRole("img", { name: "Sent via chat" }),
    ).toBeVisible();
  });

  test("agent reply after the visitor left is delivered by email", async () => {
    test.setTimeout(150_000);
    // Reply routing keeps a chat visitor "connected" for 60s after their
    // last activity (src/lib/email/routing.ts); close their page and wait
    // past that window (plus a small margin for a read already in flight at
    // close time) so the reply routes to email.
    await customerPage.close();

    const reply = "We regenerated the March invoice — the GST line is back. Mind checking?";
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    await agentPage.getByLabel(/^Reply to /u).fill(reply);
    await agentPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      agentPage.getByRole("article").filter({ hasText: reply }).first(),
    ).toBeVisible();

    outbound = await waitForEmail((email) => email.to.includes(visitorEmail));
    expect(outbound.subject).toContain(productName);
    expect(outbound.subject).toContain(`[${ticketRef}]`);
    expect(outbound.replyTo).toMatch(/reply\+[0-9a-f]+@inbound\.localhost/u);
    expect(outbound.from).toContain("no-reply@inbound.localhost");
    expect(outbound.body).toContain("GST line is back");
    expect(outbound.messageId).toMatch(/<.*@.*>/u);
    await expect(
      agentPage.getByRole("article").filter({ hasText: reply })
        .getByRole("img", { name: "Sent via email" }),
    ).toBeVisible();
  });

  test("customer email reply continues the same conversation", async () => {
    expect(outbound, "previous test must capture the outbound reply").toBeTruthy();

    const result = await postInboundEmail({
      from: visitorEmail,
      to: outbound.replyTo,
      subject: `Re: ${outbound.subject}`,
      text: `Confirmed fixed, thanks!\n\nOn Fri, 9 Oct 2026 at 9:53 AM, Away Desk Support wrote:\n> ${outbound.body.trim().split("\n").join("\n> ")}`,
      headers: {
        "Message-ID": "<customer-reply-1@mailer.test>",
        "In-Reply-To": outbound.messageId,
        References: outbound.messageId,
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });

    await expect(
      agentPage.getByText("Confirmed fixed, thanks!").first(),
    ).toBeVisible({ timeout: 20_000 });
    const reply = agentPage.getByRole("article").filter({ hasText: "Confirmed fixed, thanks!" });
    await expect(reply).not.toContainText("Support wrote:");
    await expect(reply).not.toContainText("GST line is back");
    await expect(reply.getByRole("img", { name: "Sent via email" })).toBeVisible();

    // One continued thread, not a duplicate conversation (FR-USE-01 counts a
    // Conversation once): the search finds exactly the original row.
    await agentPage.goto("/inbox?q=GST");
    const rows = agentPage.locator('ul[aria-label="Conversations"] li a');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(ticketRef);

    // Chat -> email continuation preserves the one number, and a ticket
    // reference finds the Conversation (the number is human-facing only:
    // threading above went by Message-ID / the reply token).
    await rows.first().click();
    await expect(agentPage.getByTestId("ticket-ref")).toHaveText(ticketRef);
    await agentPage.goto(`/inbox?q=${encodeURIComponent(ticketRef)}`);
    await expect(rows).toHaveCount(1);
  });
});
