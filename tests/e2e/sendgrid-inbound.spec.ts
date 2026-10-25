import { expect, test, type Page } from "@playwright/test";

import {
  loadFixtures,
  onboardWorkspaceWithProduct,
  postInboundParse,
  signIn,
  uniqueAccount,
} from "./helpers";

/**
 * SendGrid Inbound Parse intake (ADR-0004, FR-EMAIL-01) over the real
 * multipart wire format: parsed fields + attachment-info + numbered attachment
 * files, authenticated by the secret in the destination URL. Also the inbound
 * leg of the two-Workspace sanity test (docs/FRD.md, FR-SEC-01): mail for Beta's
 * Product address must appear for Beta only.
 */
test.describe.serial("SendGrid Inbound Parse intake", () => {
  const attacker = uniqueAccount();
  const nonce = Date.now().toString(36);
  const subject = `Inbound Parse invoice ${nonce}`;

  let betaPage: Page;
  let otherPage: Page;

  test.beforeAll(async ({ browser }) => {
    const fixtures = loadFixtures();
    betaPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await signIn(betaPage, fixtures.beta.owner.email, fixtures.beta.owner.password);
    otherPage = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await onboardWorkspaceWithProduct(otherPage, attacker, { name: "Other Desk", domain: "other.desk.test" });
  });

  test.afterAll(async () => {
    await betaPage?.context().close();
    await otherPage?.context().close();
  });

  test("rejects posts without the shared secret and unsupported Send Raw payloads", async () => {
    const beta = loadFixtures().beta;
    const fields = { from: "pat@customer.test", to: beta.product.inboundEmail, subject, text: "hello" };
    expect((await postInboundParse(fields, [], null)).status).toBe(401);
    expect((await postInboundParse(fields, [], "wrong")).status).toBe(401);
    expect((await postInboundParse({ email: "From: a@b.test\r\n\r\nraw mime" })).status).toBe(400);
  });

  test("creates a conversation with its attachment for the addressed Workspace only", async () => {
    const beta = loadFixtures().beta;
    const result = await postInboundParse(
      {
        headers: `Message-ID: <parse-${nonce}@customer.test>\r\nSubject: ${subject}`,
        from: "Pat Customer <pat@customer.test>",
        to: beta.product.inboundEmail,
        subject,
        text: "My latest invoice has the wrong VAT number.",
        envelope: JSON.stringify({ to: [beta.product.inboundEmail], from: "pat@customer.test" }),
        charsets: JSON.stringify({ to: "UTF-8", from: "UTF-8", subject: "UTF-8", text: "UTF-8" }),
        "attachment-info": JSON.stringify({ attachment1: { filename: "invoice.txt", type: "text/plain" } }),
        SPF: "pass",
        spam_score: "0.1",
      },
      [{ name: "attachment1", filename: "invoice.txt", type: "text/plain", content: "VAT 4012345678" }],
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });

    await betaPage.goto(`/inbox?q=${encodeURIComponent(nonce)}`);
    const row = betaPage.locator('ul[aria-label="Conversations"] li a').first();
    await expect(row).toContainText("Pat Customer");
    await row.click();
    await expect(betaPage.getByText("wrong VAT number").first()).toBeVisible();
    await expect(betaPage.getByText("invoice.txt").first()).toBeVisible();

    // Provider retries are idempotent on the RFC 5322 Message-ID.
    const retry = await postInboundParse({
      headers: `Message-ID: <parse-${nonce}@customer.test>`,
      from: "Pat Customer <pat@customer.test>",
      to: beta.product.inboundEmail,
      subject,
      text: "My latest invoice has the wrong VAT number.",
    });
    expect(retry.body).toMatchObject({ ok: true, duplicate: true });

    // The other Workspace never sees Beta's mail.
    await otherPage.goto(`/inbox?q=${encodeURIComponent(nonce)}`);
    await expect(otherPage.locator('ul[aria-label="Conversations"] li a')).toHaveCount(0);
  });
});
