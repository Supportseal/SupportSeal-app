import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { setTransportForTest, sendSystemEmail, type OutboundPayload } from "@/lib/email/outbound";
import {
  parseMultipart,
  parseSendgridInbound,
  sendgridTransport,
  setSendgridSendForTest,
} from "@/lib/email/providers/sendgrid";
import { deliverAgentReplyIfRouted } from "@/lib/email/routing";
import { addAgentMessage, upsertContact } from "@/lib/conversations";
import { type WorkspaceContext } from "@/lib/workspace";
import { POST as inboundPost } from "@/app/api/email/inbound/route";
import { allocateTicketNumber } from "@/lib/ticket";

let db: TestDb;
let ctx: WorkspaceContext;
let productId: string;
const productInbound = "product_abc123@inbound.localhost";

let sent: OutboundPayload[] = [];

const ENV_KEYS = ["SENDGRID_API_KEY", "SMTP_URL", "INBOUND_WEBHOOK_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.INBOUND_WEBHOOK_SECRET = "test-secret";
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SMTP_URL;
  setTransportForTest(null);
  db = await startTestDb();
});

afterAll(async () => {
  setSendgridSendForTest(null);
  setTransportForTest(null);
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await stopTestDb(db);
});

beforeEach(async () => {
  sent = [];
  setSendgridSendForTest(null);
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SMTP_URL;
  await db.prisma.emailDelivery.deleteMany();
  await db.prisma.attachment.deleteMany();
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversationTag.deleteMany();
  await db.prisma.tag.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const user = await createTestUser(db.prisma, { email: "founder@example.com" });
  const ws = await db.prisma.workspace.create({
    data: { name: "Acme", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  ctx = { user, workspace: { id: ws.id, name: "Acme" }, role: "ADMIN" };
  const product = await db.prisma.product.create({
    data: { workspaceId: ws.id, name: "Alpha SaaS", widgetPublicKey: "pk_sendgridtest", inboundEmail: productInbound, inboundEmailVerified: new Date() },
  });
  productId = product.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function acceptedResponse() {
  return { ok: true, status: 202, statusText: "Accepted", json: async () => null } as Response;
}

function captureSend(messageId = "<sg-1@supportseal.app>") {
  setSendgridSendForTest(async (payload) => {
    sent.push(payload);
    return { messageId };
  });
}

// ---------------------------------------------------------------------------
// Outbound: SendGrid v3 mail/send client (fetch mocked — no network, no key)
// ---------------------------------------------------------------------------

describe("sendgrid API sender", () => {
  it("posts to mail/send with a bearer key and maps the neutral payload", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(acceptedResponse());
    const transport = sendgridTransport();
    if (!transport) throw new Error("transport missing");

    const result = await transport.send({
      from: '"Alpha SaaS Support" <no-reply@inbound.localhost>',
      to: "kim@northstar.io",
      subject: "Re: Invoice question",
      text: "We regenerated your invoice.",
      headers: { "Reply-To": "reply+tok123@inbound.localhost", "In-Reply-To": "<root@sender>", References: "<root@sender>" },
      attachments: [{ filename: "invoice.png", contentType: "image/png", content: Buffer.from("png-bytes") }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer SG.test-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.personalizations).toEqual([{ to: [{ email: "kim@northstar.io" }] }]);
    expect(body.from).toEqual({ email: "no-reply@inbound.localhost", name: "Alpha SaaS Support" });
    // Reply-To is a first-class field (and a reserved header name).
    expect(body.reply_to).toEqual({ email: "reply+tok123@inbound.localhost" });
    expect(body.subject).toBe("Re: Invoice question");
    expect(body.content).toEqual([{ type: "text/plain", value: "We regenerated your invoice." }]);
    expect(body.tracking_settings).toEqual({ click_tracking: { enable: false }, open_tracking: { enable: false } });
    const headers = body.headers as Record<string, string>;
    expect(headers["Reply-To"]).toBeUndefined();
    expect(headers["In-Reply-To"]).toBe("<root@sender>");
    expect(headers["References"]).toBe("<root@sender>");
    expect(headers["Message-ID"]).toMatch(/^<[0-9a-f-]+@inbound\.localhost>$/u);
    expect(result.messageId).toBe(headers["Message-ID"]);
    expect(body.attachments).toEqual([
      { content: Buffer.from("png-bytes").toString("base64"), filename: "invoice.png", type: "image/png", disposition: "attachment" },
    ]);
  });

  it("adds a text/html part after text/plain when html is given, tracking still disabled", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(acceptedResponse());
    const transport = sendgridTransport();
    if (!transport) throw new Error("transport missing");
    await transport.send({ from: "a@b.co", to: "d@e.fr", subject: "s", text: "plain", html: "<p>styled</p>", headers: {} });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.content).toEqual([
      { type: "text/plain", value: "plain" },
      { type: "text/html", value: "<p>styled</p>" },
    ]);
    expect(body.tracking_settings).toEqual({ click_tracking: { enable: false }, open_tracking: { enable: false } });
  });

  it("strips line breaks from the subject (bounce notices echo untrusted text)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(acceptedResponse());
    const transport = sendgridTransport();
    if (!transport) throw new Error("transport missing");
    await transport.send({ from: "a@b.co", to: "d@e.fr", subject: "Undeliverable: x\r\nBcc: evil@x.test", text: "t", headers: {} });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { subject: string };
    expect(body.subject).toBe("Undeliverable: x Bcc: evil@x.test");
  });

  it("surfaces SendGrid API errors with status and message, never the key", async () => {
    process.env.SENDGRID_API_KEY = "SG.secret-key-value";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ errors: [{ message: "The from address does not match a verified Sender Identity.", field: "from" }] }),
    } as Response);
    const transport = sendgridTransport();
    if (!transport) throw new Error("transport missing");
    const attempt = transport.send({ from: "a@b.co", to: "d@e.fr", subject: "s", text: "t", headers: {} });
    await expect(attempt).rejects.toThrow(/sendgrid send failed \(403\).*Sender Identity.*\(from\)/u);
    await expect(attempt).rejects.not.toThrow(/secret-key-value/u);

    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500, statusText: "Server Error", json: async () => { throw new Error("no body"); } } as unknown as Response);
    await expect(
      transport.send({ from: "a@b.co", to: "d@e.fr", subject: "s", text: "t", headers: {} }),
    ).rejects.toThrow(/sendgrid send failed \(500\): Server Error/u);
  });

  it("returns a null transport when no key is configured", () => {
    expect(sendgridTransport()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outbound wiring: reply routing + system email through the SendGrid seam
// ---------------------------------------------------------------------------

describe("outbound wiring (ADR-0004 boundary)", () => {
  let seedCount = 0;
  async function seedEmailConversation() {
    seedCount += 1;
    const contact = await upsertContact({ workspaceId: ctx.workspace.id, email: "kim@northstar.io" });
    const conversation = await db.prisma.conversation.create({
      data: {
        workspaceId: ctx.workspace.id,
        ticketNumber: await allocateTicketNumber(db.prisma, ctx.workspace.id),
        productId,
        contactId: contact.id,
        channel: "EMAIL",
        subject: "Invoice question",
        emailReplyToken: `reptoken${seedCount}`,
        emailMessageId: "<root@sender>",
      },
    });
    const message = await addAgentMessage({ ctx, conversationId: conversation.id, body: "We regenerated your invoice." });
    if (!message.ok) throw new Error(message.error);
    return { conversation, messageId: message.messageId };
  }

  it("delivers agent replies through SendGrid and records the Message-ID we set", async () => {
    captureSend("<sg-msg-1@inbound.localhost>");
    const { conversation, messageId } = await seedEmailConversation();
    const result = await deliverAgentReplyIfRouted({ workspaceId: ctx.workspace.id, conversationId: conversation.id, messageId });
    expect(result.routed).toBe("email");
    expect(result.sent).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].from).toContain("Alpha SaaS Support");
    expect(sent[0].headers["Reply-To"]).toContain(`reply+reptoken${seedCount}@`);
    expect(sent[0].headers["In-Reply-To"]).toBe("<root@sender>");
    const delivery = await db.prisma.emailDelivery.findFirstOrThrow({ where: { direction: "OUTBOUND" } });
    expect(delivery.status).toBe("SENT");
    expect(delivery.providerMessageId).toBe("<sg-msg-1@inbound.localhost>");

    // Idempotent: a second delivery attempt never re-sends.
    await deliverAgentReplyIfRouted({ workspaceId: ctx.workspace.id, conversationId: conversation.id, messageId });
    expect(sent.length).toBe(1);
  });

  it("records provider failures as FAILED instead of pretending success", async () => {
    setSendgridSendForTest(async () => {
      throw new Error("sendgrid send failed (403): from address not verified");
    });
    const { conversation, messageId } = await seedEmailConversation();
    const failed = await deliverAgentReplyIfRouted({ workspaceId: ctx.workspace.id, conversationId: conversation.id, messageId });
    expect(failed.sent).toBe(false);
    expect(failed.error).toContain("403");
    const deliveries = await db.prisma.emailDelivery.findMany({ where: { direction: "OUTBOUND" } });
    expect(deliveries.some((d) => d.status === "FAILED" && d.reason?.includes("403"))).toBe(true);
  });

  it("prefers the SendGrid API over SMTP when both are configured, and SMTP alone still works", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.SMTP_URL = "smtps://user:pass@smtp.example.com:465";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(acceptedResponse());
    const smtpSend = vi.fn().mockResolvedValue({ messageId: "<smtp@x>" });
    const viaSendgrid = await sendSystemEmail({ to: "admin@example.com", subject: "Allowance", text: "80% used" });
    expect(viaSendgrid).toEqual({ ok: true, delivered: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(smtpSend).not.toHaveBeenCalled();

    // Self-hosted: no SendGrid key → falls through to SMTP, never requires SendGrid.
    delete process.env.SENDGRID_API_KEY;
    setTransportForTest({ sendMail: smtpSend } as never);
    const viaSmtp = await sendSystemEmail({ to: "admin@example.com", subject: "Allowance", text: "80% used" });
    expect(viaSmtp).toEqual({ ok: true, delivered: true });
    expect(smtpSend).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    // Neither configured: record-only dev mode.
    setTransportForTest(null);
    delete process.env.SMTP_URL;
    expect(await sendSystemEmail({ to: "a@b.co", subject: "s", text: "t" })).toEqual({ ok: true, delivered: false });
  });
});

// ---------------------------------------------------------------------------
// Inbound Parse: multipart parsing with the sample payload fixture
// ---------------------------------------------------------------------------

type FixtureField = { text?: string; base64?: string };
type Fixture = {
  fields: Record<string, FixtureField>;
  files: Array<{ name: string; filename: string; type: string; base64: string }>;
};

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "sendgrid-inbound-parse.json"), "utf8"),
) as Fixture;

const BOUNDARY = "xYzZY";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

function fieldBytes(field: FixtureField): Buffer {
  return field.base64 !== undefined ? Buffer.from(field.base64, "base64") : Buffer.from(field.text ?? "", "utf8");
}

/** Build a multipart body the way SendGrid does: raw field bytes, CRLF framing. */
function multipartBody(
  fields: Record<string, FixtureField>,
  files: Fixture["files"] = [],
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, field] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      fieldBytes(field),
      Buffer.from("\r\n"),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      Buffer.from(file.base64, "base64"),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function fixtureFields(overrides: Record<string, FixtureField | null> = {}) {
  const fields: Record<string, FixtureField> = { ...fixture.fields };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete fields[key];
    else fields[key] = value;
  }
  return fields;
}

function messageIdHeaders(id: string, extra = "") {
  return { base64: Buffer.from(`Message-ID: ${id}\r\n${extra}Content-Type: text/plain\r\n`).toString("base64") };
}

describe("parseMultipart", () => {
  it("keeps raw field bytes, files, empty fields and binary content intact", () => {
    const binary = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0xe9]);
    const body = multipartBody(
      { empty: { text: "" }, latin: { base64: Buffer.from([0xe9]).toString("base64") } },
      [{ name: "attachment1", filename: "a.bin", type: "application/octet-stream", base64: binary.toString("base64") }],
    );
    const parts = parseMultipart(body, CONTENT_TYPE);
    expect(parts.map((p) => p.name)).toEqual(["empty", "latin", "attachment1"]);
    expect(parts[0].data.length).toBe(0);
    expect([...parts[1].data]).toEqual([0xe9]);
    expect(parts[2].filename).toBe("a.bin");
    expect(parts[2].data.equals(binary)).toBe(true);
  });

  it("rejects bodies without a boundary or terminator", () => {
    expect(() => parseMultipart(Buffer.from("x"), "multipart/form-data")).toThrow(/boundary/u);
    expect(() => parseMultipart(Buffer.from("x"), CONTENT_TYPE)).toThrow(/delimiter/u);
    expect(() =>
      parseMultipart(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue`), CONTENT_TYPE),
    ).toThrow(/unterminated/u);
  });
});

describe("parseSendgridInbound", () => {
  it("maps the sample Inbound Parse payload onto the neutral InboundEmail", () => {
    const { email, meta } = parseSendgridInbound(multipartBody(fixture.fields, fixture.files), CONTENT_TYPE);
    expect(email.from).toEqual({ email: "renee@customer.example", name: "Renée Dupont" });
    // Envelope recipient first, then To, then Cc — de-duplicated.
    expect(email.to).toEqual([productInbound, "other@customer.example"]);
    expect(email.subject).toBe("Facture manquante");
    // ISO-8859-1 field bytes are decoded using the charsets field.
    expect(email.text).toContain("incomplète");
    expect(email.html).toContain("incomplète");
    expect(email.headers.messageId).toBe("<CAF=Xx+9wq1@mail.customer.example>");
    expect(email.headers.inReplyTo).toBe("<earlier-root@inbound.localhost>");
    // Folded References header is unfolded into both ids.
    expect(email.headers.references).toEqual(["<root@mail.customer.example>", "<earlier-root@inbound.localhost>"]);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ filename: "facture-mars.txt", contentType: "text/plain" });
    expect(Buffer.from(email.attachments[0].data).toString()).toBe("Total: R 1 200.00\n");
    expect(meta).toEqual({
      envelopeTo: [productInbound],
      spf: "pass",
      dkim: "{@customer.example : pass}",
      spamScore: "0.012",
      senderIp: "203.0.113.41",
    });
  });

  it("falls back to the envelope sender and tolerates bad JSON fields and unknown charsets", () => {
    const body = multipartBody(
      fixtureFields({
        from: { text: "not an address" },
        envelope: { text: '{"to":["product_abc123@inbound.localhost"],"from":"Fallback <fb@sender.test>"}' },
        charsets: { text: '{"text":"made-up-charset"}' },
        "attachment-info": { text: "{broken" },
      }),
      fixture.files,
    );
    const { email } = parseSendgridInbound(body, CONTENT_TYPE);
    expect(email.from.email).toBe("fb@sender.test");
    expect(email.text).toBeTruthy();
    // attachment-info unreadable: falls back to the multipart filename.
    expect(email.attachments[0].filename).toBe("facture-mars.txt");
  });

  it("rejects Send Raw payloads and posts without any usable sender", () => {
    const raw = multipartBody({ email: { text: "From: a@b.co\r\n\r\nbody" }, to: { text: productInbound } });
    expect(() => parseSendgridInbound(raw, CONTENT_TYPE)).toThrow(/Send Raw/u);
    const noSender = multipartBody(fixtureFields({ from: null, envelope: null }));
    expect(() => parseSendgridInbound(noSender, CONTENT_TYPE)).toThrow(/invalid from/u);
  });

  it("caps attachments at ten", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      name: `attachment${i + 1}`,
      filename: `f${i}.txt`,
      type: "text/plain",
      base64: Buffer.from(`file ${i}`).toString("base64"),
    }));
    const { email } = parseSendgridInbound(multipartBody(fixtureFields(), files), CONTENT_TYPE);
    expect(email.attachments).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Inbound webhook route with SendGrid multipart traffic
// ---------------------------------------------------------------------------

function multipartRequest(body: Buffer, init: { query?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost/api/email/inbound${init.query ?? ""}`, {
    method: "POST",
    headers: { "content-type": CONTENT_TYPE, ...init.headers },
    body: new Uint8Array(body),
  });
}

const goodBody = () => multipartBody(fixture.fields, fixture.files);

describe("inbound webhook route (SendGrid multipart)", () => {
  it("rejects missing or wrong secrets and accepts ?secret=, header and Basic auth", async () => {
    expect((await inboundPost(multipartRequest(goodBody()))).status).toBe(401);
    expect((await inboundPost(multipartRequest(goodBody(), { query: "?secret=wrong" }))).status).toBe(401);
    expect((await inboundPost(multipartRequest(goodBody(), { headers: { "x-supportseal-inbound-secret": "nope" } }))).status).toBe(401);
    expect(await db.prisma.conversation.count()).toBe(0);

    expect((await inboundPost(multipartRequest(goodBody(), { query: "?secret=test-secret" }))).status).toBe(200);
    const basic = Buffer.from("test-secret:").toString("base64");
    const body2 = multipartBody(fixtureFields({ headers: messageIdHeaders("<basic@x>") }));
    expect((await inboundPost(multipartRequest(body2, { headers: { authorization: `Basic ${basic}` } }))).status).toBe(200);
    const body3 = multipartBody(fixtureFields({ headers: messageIdHeaders("<hdr@x>") }));
    expect((await inboundPost(multipartRequest(body3, { headers: { "x-supportseal-inbound-secret": "test-secret" } }))).status).toBe(200);
    expect(await db.prisma.conversation.count()).toBe(3);
  });

  it("creates a conversation with decoded text, attachment and recorded Message-ID, idempotently", async () => {
    const first = await inboundPost(multipartRequest(goodBody(), { query: "?secret=test-secret" }));
    expect(first.status).toBe(200);
    const conversation = await db.prisma.conversation.findFirstOrThrow({ where: { productId } });
    expect(conversation.emailMessageId).toBe("<CAF=Xx+9wq1@mail.customer.example>");
    expect(conversation.subject).toBe("Facture manquante");
    const message = await db.prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id }, include: { attachments: true } });
    expect(message.body).toContain("incomplète");
    expect(message.attachments.map((a) => a.filename)).toEqual(["facture-mars.txt"]);

    // SendGrid retries (and has no provider message id): dedupe on Message-ID.
    const again = await inboundPost(multipartRequest(goodBody(), { query: "?secret=test-secret" }));
    expect(((await again.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count()).toBe(1);
  });

  it("threads a follow-up by References from our outbound mail, never by subject", async () => {
    await inboundPost(multipartRequest(goodBody(), { query: "?secret=test-secret" }));
    const followUp = multipartBody(
      fixtureFields({
        subject: { text: "Totally different subject" },
        headers: messageIdHeaders("<followup@customer.example>", "References: <CAF=Xx+9wq1@mail.customer.example>\r\n"),
      }),
    );
    expect((await inboundPost(multipartRequest(followUp, { query: "?secret=test-secret" }))).status).toBe(200);
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count()).toBe(2);

    const subjectOnly = multipartBody(fixtureFields({ headers: messageIdHeaders("<unrelated@customer.example>") }));
    await inboundPost(multipartRequest(subjectOnly, { query: "?secret=test-secret" }));
    expect(await db.prisma.conversation.count()).toBe(2);
  });

  it("continues a conversation via the reply+token envelope recipient", async () => {
    const contact = await upsertContact({ workspaceId: ctx.workspace.id, email: "renee@customer.example" });
    const conversation = await db.prisma.conversation.create({
      data: { workspaceId: ctx.workspace.id, ticketNumber: await allocateTicketNumber(db.prisma, ctx.workspace.id), productId, contactId: contact.id, channel: "EMAIL", subject: "Hi", emailReplyToken: "tok9", emailMessageId: "<seed@x>" },
    });
    const body = multipartBody(
      fixtureFields({
        envelope: { text: '{"to":["reply+tok9@inbound.localhost"],"from":"renee@customer.example"}' },
        to: { text: "reply+tok9@inbound.localhost" },
        headers: messageIdHeaders("<reply-token@customer.example>"),
      }),
    );
    expect((await inboundPost(multipartRequest(body, { query: "?secret=test-secret" }))).status).toBe(200);
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count({ where: { conversationId: conversation.id } })).toBe(1);
  });

  it("never lands mail addressed to Workspace B's token in Workspace A (cross-tenant)", async () => {
    const userB = await createTestUser(db.prisma, { email: "other@example.com" });
    const wsB = await db.prisma.workspace.create({
      data: { name: "Bravo", memberships: { create: { userId: userB.id, role: "ADMIN" } } },
    });
    const productB = await db.prisma.product.create({
      data: { workspaceId: wsB.id, name: "Bravo", widgetPublicKey: "pk_bravo", inboundEmail: "product_bravo@inbound.localhost", inboundEmailVerified: new Date() },
    });
    const contactB = await upsertContact({ workspaceId: wsB.id, email: "bob@bravo.example" });
    const convB = await db.prisma.conversation.create({
      data: { workspaceId: wsB.id, ticketNumber: await allocateTicketNumber(db.prisma, wsB.id), productId: productB.id, contactId: contactB.id, channel: "EMAIL", subject: "B", emailReplyToken: "tokB", emailMessageId: "<b-root@x>" },
    });

    // A sender who is not a participant in B's conversation uses B's token.
    const attack = multipartBody(
      fixtureFields({
        envelope: { text: '{"to":["reply+tokB@inbound.localhost"],"from":"renee@customer.example"}' },
        to: { text: "reply+tokB@inbound.localhost" },
        headers: messageIdHeaders("<attack@customer.example>"),
      }),
    );
    expect((await inboundPost(multipartRequest(attack, { query: "?secret=test-secret" }))).status).toBe(200);
    expect(await db.prisma.message.count({ where: { conversationId: convB.id } })).toBe(0);
    expect(await db.prisma.conversation.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);

    // Threading headers that quote B's Message-ID must not pull A's mail into B.
    const crossHeader = multipartBody(
      fixtureFields({ headers: messageIdHeaders("<cross@customer.example>", "In-Reply-To: <b-root@x>\r\n") }),
    );
    await inboundPost(multipartRequest(crossHeader, { query: "?secret=test-secret" }));
    expect(await db.prisma.message.count({ where: { conversationId: convB.id } })).toBe(0);
    const created = await db.prisma.conversation.findFirstOrThrow({ where: { workspaceId: ctx.workspace.id } });
    expect(created.productId).toBe(productId);
  });

  it("logs and 400s unparseable payloads, loudly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const garbage = new NextRequest("http://localhost/api/email/inbound?secret=test-secret", {
      method: "POST",
      headers: { "content-type": CONTENT_TYPE },
      body: "not multipart",
    });
    expect((await inboundPost(garbage)).status).toBe(400);
    const raw = multipartBody({ email: { text: "From: a@b.co\r\n\r\nhi" } });
    expect((await inboundPost(multipartRequest(raw, { query: "?secret=test-secret" }))).status).toBe(400);
    expect(errorSpy).toHaveBeenCalledWith("[inbound-email] bad request:", expect.stringMatching(/Send Raw/u));
    expect(await db.prisma.conversation.count()).toBe(0);
  });

  it("rejects bodies over the size cap without buffering them (no Content-Length needed)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const chunk = new Uint8Array(1024 * 1024);
    let sentChunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sentChunks += 1;
        controller.enqueue(chunk);
        if (sentChunks >= 200) controller.close();
      },
    });
    const request = new NextRequest("http://localhost/api/email/inbound?secret=test-secret", {
      method: "POST",
      headers: { "content-type": CONTENT_TYPE },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    expect((await inboundPost(request)).status).toBe(400);
    expect(sentChunks).toBeLessThan(60);
  });

  it("logs a summary with verdicts for accepted mail and a warning for rejected mail", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await inboundPost(multipartRequest(goodBody(), { query: "?secret=test-secret" }));
    expect(infoSpy).toHaveBeenCalledWith(
      "[inbound-email] created",
      expect.objectContaining({ messageId: "<CAF=Xx+9wq1@mail.customer.example>", spf: "pass", spamScore: "0.012", fromDomain: "customer.example" }),
    );
    const unknown = multipartBody(
      fixtureFields({
        envelope: { text: '{"to":["nobody@inbound.localhost"],"from":"renee@customer.example"}' },
        to: { text: "nobody@inbound.localhost" },
        headers: messageIdHeaders("<unknown@x>"),
      }),
    );
    const res = await inboundPost(multipartRequest(unknown, { query: "?secret=test-secret" }));
    expect(((await res.json()) as { rejected?: boolean }).rejected).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith("[inbound-email] rejected", expect.objectContaining({ reason: expect.stringContaining("no product matches") }));
  });
});
