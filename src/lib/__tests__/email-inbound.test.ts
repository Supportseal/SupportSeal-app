import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import {
  htmlToText,
  inboundAttachmentStorageKey,
  InboundRejectError,
  markInboundDeliveryComplete,
  parseAddress,
  processInboundEmail,
  resolveContactSender,
  type InboundEmail,
} from "@/lib/email/inbound";
import { POST as inboundPost } from "@/app/api/email/inbound/route";
import { setAttachmentStorageForTest, type AttachmentStorage } from "@/lib/attachment-storage";
import { MAX_INBOUND_BYTES } from "@/lib/email/providers/sendgrid";
import { inboundDomain } from "@/lib/email/outbound";
import { addCustomerMessage } from "@/lib/conversations";
import { storeAttachment, validateAttachment } from "@/lib/attachments";
import { createProduct } from "@/lib/products";
import type { WorkspaceContext } from "@/lib/workspace";

let db: TestDb;
let productId: string;
let productInbound: string;
let workspaceId: string;

process.env.INBOUND_WEBHOOK_SECRET = "test-secret";

/** In-memory storage honouring deterministic keys (inbound reprocessing). */
class KeyedMemoryStorage implements AttachmentStorage {
  files = new Map<string, Uint8Array>();
  async put(data: Uint8Array, key?: string) {
    const storageKey = key ?? `mem${this.files.size + 1}`;
    this.files.set(storageKey, data);
    return storageKey;
  }
  async get(key: string) {
    const file = this.files.get(key);
    if (!file) throw new Error("not found");
    return file;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

const keyedStorage = new KeyedMemoryStorage();

function pngBytes(bytes: number, salt = 0): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  data[20] = salt;
  return data;
}

function email(
  overrides: Partial<Omit<InboundEmail, "headers">> & { headers?: Partial<InboundEmail["headers"]> } = {},
): InboundEmail {
  return {
    from: { email: "sam@fastmail.dev", name: "Sam Rivera" },
    to: [productInbound],
    subject: "Invoice question",
    text: "Hi, my invoice PDF is missing the tax line.",
    html: null,
    attachments: [],
    ...overrides,
    headers: {
      messageId: null,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      xAutoreply: null,
      replyTo: null,
      ...overrides.headers,
    },
  };
}

async function postInbound(body: unknown, secret = "test-secret") {
  const request = new NextRequest("http://localhost:3000/api/email/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", [INBOUND_HEADER]: secret },
    body: JSON.stringify(body),
  });
  return inboundPost(request);
}

const INBOUND_HEADER = "x-supportseal-inbound-secret";

function jsonEmail(overrides: Record<string, unknown> = {}) {
  return {
    from: "Sam Rivera <sam@fastmail.dev>",
    to: productInbound,
    subject: "Invoice question",
    text: "Hi, my invoice PDF is missing the tax line.",
    headers: {},
    ...overrides,
  };
}

beforeAll(async () => {
  db = await startTestDb();
  setAttachmentStorageForTest(keyedStorage);
});

afterAll(async () => {
  setAttachmentStorageForTest(null);
  await stopTestDb(db);
});

beforeEach(async () => {
  keyedStorage.files.clear();
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
  const workspace = await db.prisma.workspace.create({
    data: { name: "Acme", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  productInbound = "product_abc123@inbound.localhost";
  productId = (
    await db.prisma.product.create({
      data: {
        workspaceId: workspace.id,
        name: "Alpha SaaS",
        widgetPublicKey: "pk_inboundtest",
        inboundEmail: productInbound,
        inboundEmailVerified: new Date(),
      },
    })
  ).id;
  workspaceId = workspace.id;
});

describe("address + html parsing", () => {
  it("parses display-name addresses", () => {
    expect(parseAddress("Sam Rivera <SAM@FastMail.dev>")).toEqual({ email: "SAM@fastmail.dev", name: "Sam Rivera" });
    expect(parseAddress("plain@example.com")).toEqual({ email: "plain@example.com", name: null });
    expect(parseAddress("not an address")).toBeNull();
    expect(parseAddress(null)).toBeNull();
  });

  it("converts html to readable text", () => {
    expect(htmlToText("<p>Hi<br>there</p><script>alert(1)</script><style>x{}</style>")).toBe("Hi\nthere");
    expect(htmlToText("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
  });
});

describe("inbound processing (FR-EMAIL-01/03)", () => {
  it("creates a conversation for a new email and dedupes by Message-ID", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<m1@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const conversation = await db.prisma.conversation.findFirstOrThrow();
    expect(conversation.channel).toBe("EMAIL");
    expect(conversation.subject).toBe("Invoice question");
    expect(conversation.emailMessageId).toBe("<m1@sender>");
    expect(conversation.emailReplyToken).not.toBeNull();
    const contact = await db.prisma.contact.findFirstOrThrow();
    expect(contact.email).toBe("sam@fastmail.dev");
    expect(contact.name).toBe("Sam Rivera");

    const duplicate = await processInboundEmail({
      email: email({ text: "different body", headers: { ...email().headers, messageId: "<m1@sender>" } }),
    });
    expect(duplicate.outcome).toBe("duplicate");
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count()).toBe(1);
  });

  it("threads replies by In-Reply-To/References into the same conversation", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<root@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));

    const reply = await processInboundEmail({
      email: email({
        text: "Following up on that invoice.",
        subject: "Re: Invoice question",
        headers: {
          ...email().headers,
          messageId: "<reply@sender>",
          inReplyTo: "<root@sender>",
          references: ["<older@sender>", "<root@sender>"],
        },
      }),
    });
    if (reply.outcome !== "created") throw new Error(JSON.stringify(reply));
    expect(reply.conversationId).toBe(first.conversationId);
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count()).toBe(2);
  });

  it("threads by References alone (no In-Reply-To)", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<refroot@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const reply = await processInboundEmail({
      email: email({
        text: "Threaded only via References.",
        headers: {
          ...email().headers,
          messageId: "<refreply@sender>",
          inReplyTo: null,
          references: ["<other@sender>", "<refroot@sender>"],
        },
      }),
    });
    if (reply.outcome !== "created") throw new Error(JSON.stringify(reply));
    expect(reply.conversationId).toBe(first.conversationId);
  });

  it("never threads by subject alone", async () => {
    await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<a@sender>" } }),
    });
    // Same subject, no threading headers -> a new conversation.
    const second = await processInboundEmail({
      email: email({
        headers: { ...email().headers, messageId: "<b@sender>" },
      }),
    });
    if (second.outcome !== "created") throw new Error(JSON.stringify(second));
    expect(await db.prisma.conversation.count()).toBe(2);
  });

  it("continues via the reply+token address", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<r@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const conversation = await db.prisma.conversation.findFirstOrThrow();

    const continued = await processInboundEmail({
      email: email({
        to: [`reply+${conversation.emailReplyToken}@inbound.localhost`],
        text: "Replying to your reply by mail.",
        headers: { ...email().headers, messageId: "<c@sender>" },
      }),
    });
    if (continued.outcome !== "created") throw new Error(JSON.stringify(continued));
    expect(continued.conversationId).toBe(conversation.id);
  });

  it("ignores autoresponses and records them", async () => {
    const result = await processInboundEmail({
      email: email({
        headers: { ...email().headers, messageId: "<auto@sender>", autoSubmitted: "auto-replied" },
      }),
    });
    expect(result.outcome).toBe("ignored");
    expect(await db.prisma.conversation.count()).toBe(0);
    const delivery = await db.prisma.emailDelivery.findFirstOrThrow();
    expect(delivery.status).toBe("IGNORED");
  });

  describe("mail-loop guard", () => {
    const ownMessageId = () => `<0b5b0d3e-8f0f-4c7e-9c53-2d7b6a1f9e11@${inboundDomain()}>`;

    async function expectIgnoredLoop(mail: InboundEmail, reason: RegExp) {
      const result = await processInboundEmail({ email: mail });
      expect(result.outcome).toBe("ignored");
      expect(await db.prisma.conversation.count()).toBe(0);
      const delivery = await db.prisma.emailDelivery.findFirstOrThrow();
      expect(delivery.status).toBe("IGNORED");
      expect(delivery.reason).toMatch(reason);
    }

    it("drops mail from the product's own support address", async () => {
      await db.prisma.product.update({ where: { id: productId }, data: { supportEmail: "support@acme.com" } });
      await expectIgnoredLoop(
        email({
          from: { email: "support@acme.com", name: "Acme Support" },
          headers: { messageId: "<loop-1@acme.com>" },
        }),
        /own support/u,
      );
    });

    it("drops mail from the generated forwarding address and from our managed sender", async () => {
      await expectIgnoredLoop(
        email({ from: { email: productInbound, name: null }, headers: { messageId: "<loop-2@x>" } }),
        /own support/u,
      );
    });

    it("drops mail that carries our X-SupportSeal stamp or our own Message-ID", async () => {
      await expectIgnoredLoop(
        email({ headers: { messageId: "<loop-3@x>", xSupportSeal: inboundDomain() } }),
        /X-SupportSeal/u,
      );
    });

    it("drops mail whose Message-ID was issued by this instance", async () => {
      await expectIgnoredLoop(email({ headers: { messageId: ownMessageId() } }), /Message-ID/u);
    });

    it("drops Precedence: auto_reply but keeps Auto-Submitted: no", async () => {
      await expectIgnoredLoop(
        email({ headers: { messageId: "<loop-4@x>", precedence: "auto_reply" } }),
        /auto-response/u,
      );
      await db.prisma.emailDelivery.deleteMany();
      const kept = await processInboundEmail({
        email: email({ headers: { messageId: "<real-1@x>", autoSubmitted: "no" } }),
      });
      expect(kept.outcome).toBe("created");
    });

    it("ignores (never bounces) a looping mail to an archived product", async () => {
      await db.prisma.product.update({
        where: { id: productId },
        data: { supportEmail: "support@acme.com", archivedAt: new Date() },
      });
      await expectIgnoredLoop(
        email({
          from: { email: "support@acme.com", name: null },
          headers: { messageId: "<loop-5@acme.com>" },
        }),
        /own support/u,
      );
    });

    it("reads the X-SupportSeal header from a webhook body, case-insensitively", async () => {
      const response = await postInbound(
        jsonEmail({ headers: { "x-supportseal": inboundDomain(), "Message-ID": "<loop-6@x>" } }),
      );
      expect(await response.json()).toMatchObject({ ok: true, ignored: true });
      expect(await db.prisma.conversation.count()).toBe(0);
    });
  });

  it("rejects mail to an archived product and unknown addresses", async () => {
    await db.prisma.product.update({ where: { id: productId }, data: { archivedAt: new Date() } });
    const archived = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<x@sender>" } }),
    });
    if (archived.outcome !== "rejected") throw new Error(JSON.stringify(archived));
    expect(archived.bounce).toBe(true);
    expect(await db.prisma.conversation.count()).toBe(0);

    await db.prisma.product.update({ where: { id: productId }, data: { archivedAt: null } });
    const unknown = await processInboundEmail({
      email: email({ to: ["nobody@inbound.localhost"], headers: { ...email().headers, messageId: "<y@sender>" } }),
    });
    if (unknown.outcome !== "rejected") throw new Error(JSON.stringify(unknown));
  });

  it("does not route mail to an unverified inbound address (issue #169)", async () => {
    await db.prisma.product.update({ where: { id: productId }, data: { inboundEmailVerified: null } });
    const unverified = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<unverified@sender>" } }),
    });
    if (unverified.outcome !== "rejected") throw new Error(JSON.stringify(unverified));
    expect(await db.prisma.conversation.count()).toBe(0);

    await db.prisma.product.update({ where: { id: productId }, data: { inboundEmailVerified: new Date() } });
    const verified = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<verified@sender>" } }),
    });
    expect(verified.outcome).toBe("created");
  });

  it("routes mail to the address generated for a freshly created Product without a manual verify step (issue #169)", async () => {
    const ctx: WorkspaceContext = {
      user: await db.prisma.user.findFirstOrThrow(),
      workspace: { id: workspaceId, name: "Acme" },
      role: "ADMIN",
    };
    const created = await createProduct({ ctx, name: "Fresh" });
    if (!created.ok || !created.product.inboundEmail) throw new Error("createProduct failed");
    const result = await processInboundEmail({
      email: email({
        to: [created.product.inboundEmail],
        headers: { ...email().headers, messageId: "<fresh@sender>" },
      }),
    });
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    const conversation = await db.prisma.conversation.findFirstOrThrow();
    expect(conversation.productId).toBe(created.product.id);
  });

  it("stores valid attachments with the message and drops unsafe ones", async () => {
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const exe = new Uint8Array(64);
    exe.set([0x4d, 0x5a]);
    const result = await processInboundEmail({
      email: email({
        headers: { ...email().headers, messageId: "<att@sender>" },
        attachments: [
          { filename: "invoice.png", contentType: "image/png", data: png },
          { filename: "evil.exe", contentType: "application/octet-stream", data: exe },
        ],
      }),
    });
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    expect(await db.prisma.attachment.count()).toBe(1);
    const stored = await db.prisma.attachment.findFirstOrThrow();
    expect(stored.filename).toBe("invoice.png");
    const message = await db.prisma.message.findFirstOrThrow({ include: { attachments: true } });
    expect(message.attachments.length).toBe(1);
  });
});

describe("Reply-To sender resolution (issue #150)", () => {
  const relayFrom = { email: "forms@relay.example", name: "Contact Form" };
  const withReplyTo = (replyTo: string | null, overrides: Partial<InboundEmail> = {}) =>
    email({ from: relayFrom, headers: { ...email().headers, replyTo }, ...overrides });

  it("prefers a valid Reply-To over From, keeping its display name", () => {
    expect(resolveContactSender(withReplyTo("Sam Rivera <SAM@FastMail.dev>"))).toEqual({
      email: "SAM@fastmail.dev",
      name: "Sam Rivera",
    });
    expect(resolveContactSender(withReplyTo("sam@fastmail.dev"))).toEqual({ email: "sam@fastmail.dev", name: null });
  });

  it("falls back to From when Reply-To is absent or invalid", () => {
    expect(resolveContactSender(withReplyTo(null))).toBe(relayFrom);
    expect(resolveContactSender(withReplyTo("not an address"))).toBe(relayFrom);
    expect(resolveContactSender(withReplyTo("<>"))).toBe(relayFrom);
  });

  it("uses the first valid entry of a Reply-To list, respecting quoted commas", () => {
    expect(resolveContactSender(withReplyTo('"Rivera, Sam" <sam@fastmail.dev>, other@x.dev')).email).toBe(
      "sam@fastmail.dev",
    );
    expect(resolveContactSender(withReplyTo("garbage, sam@fastmail.dev")).email).toBe("sam@fastmail.dev");
  });

  it("ignores a Reply-To that points back at one of the recipients", () => {
    expect(resolveContactSender(withReplyTo(productInbound.toUpperCase()))).toBe(relayFrom);
  });

  it("attributes a relayed mail to the Reply-To contact and keeps From for audit", async () => {
    const result = await processInboundEmail({
      email: withReplyTo("Sam Rivera <sam@fastmail.dev>", {
        headers: { ...email().headers, messageId: "<relay@sender>", replyTo: "Sam Rivera <sam@fastmail.dev>" },
      }),
    });
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    const conversation = await db.prisma.conversation.findFirstOrThrow({ include: { contact: true } });
    expect(conversation.contact?.email).toBe("sam@fastmail.dev");
    expect(conversation.contact?.name).toBe("Sam Rivera");
    expect(await db.prisma.contact.count({ where: { email: "forms@relay.example" } })).toBe(0);
    const delivery = await db.prisma.emailDelivery.findFirstOrThrow({ where: { direction: "INBOUND" } });
    expect(delivery.fromAddress).toBe("forms@relay.example");
  });

  it("keeps attributing to From when Reply-To is unusable", async () => {
    const result = await processInboundEmail({
      email: withReplyTo("bogus", {
        headers: { ...email().headers, messageId: "<bogus@sender>", replyTo: "bogus" },
      }),
    });
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    const contact = await db.prisma.contact.findFirstOrThrow();
    expect(contact.email).toBe("forms@relay.example");
  });

  it("keeps two visitors behind one relay apart when nothing else differs and there is no Message-ID", async () => {
    const visitor = (replyTo: string) =>
      withReplyTo(replyTo, {
        text: null,
        headers: { ...email().headers, messageId: null, replyTo },
      });
    const first = await processInboundEmail({ email: visitor("ann@fastmail.dev") });
    const second = await processInboundEmail({ email: visitor("bob@fastmail.dev") });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    if (second.outcome !== "created") throw new Error(JSON.stringify(second));
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(await db.prisma.contact.count()).toBe(2);

    // A provider retry of the same relayed mail is still deduplicated.
    const retry = await processInboundEmail({ email: visitor("ann@fastmail.dev") });
    expect(retry.outcome).toBe("duplicate");
    expect(await db.prisma.conversation.count()).toBe(2);
  });

  it("accepts a reply-token continuation whose Reply-To contact is the participant", async () => {
    const first = await processInboundEmail({
      email: withReplyTo("sam@fastmail.dev", {
        headers: { ...email().headers, messageId: "<rt1@sender>", replyTo: "sam@fastmail.dev" },
      }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const conversation = await db.prisma.conversation.findFirstOrThrow();

    const continued = await processInboundEmail({
      email: withReplyTo("sam@fastmail.dev", {
        to: [`reply+${conversation.emailReplyToken}@inbound.localhost`],
        headers: { ...email().headers, messageId: "<rt2@sender>", replyTo: "sam@fastmail.dev" },
      }),
    });
    if (continued.outcome !== "created") throw new Error(JSON.stringify(continued));
    expect(continued.conversationId).toBe(conversation.id);

    const stranger = await processInboundEmail({
      email: email({
        from: { email: "eve@elsewhere.dev", name: null },
        to: [`reply+${conversation.emailReplyToken}@inbound.localhost`],
        headers: { ...email().headers, messageId: "<rt3@sender>", replyTo: "eve@elsewhere.dev" },
      }),
    });
    expect(stranger.outcome).toBe("rejected");
  });

  it("reads Reply-To from webhook headers (JSON bridge, any case)", async () => {
    const response = await postInbound(
      jsonEmail({
        from: "Contact Form <forms@relay.example>",
        headers: { "Message-ID": "<hdr@sender>", "reply-to": "Sam Rivera <sam@fastmail.dev>" },
      }),
    );
    expect(response.status).toBe(200);
    expect((await db.prisma.contact.findFirstOrThrow()).email).toBe("sam@fastmail.dev");
  });
});

describe("inbound quote stripping + channel (issue #128)", () => {
  it("stores only the visitor's reply text when the plain-text mail quotes the original", async () => {
    const result = await processInboundEmail({
      email: email({
        text: "not sure how i feel about this\nOn 10/9/2026 9:53 AM, IndieDevTest Support wrote:\n> thanks oldie",
        headers: { ...email().headers, messageId: "<quote1@sender>" },
      }),
    });
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    const message = await db.prisma.message.findFirstOrThrow();
    expect(message.body).toBe("not sure how i feel about this");
    expect(message.channel).toBe("EMAIL");
  });

  it("stores only the reply for HTML-only mail with a confidently marked Gmail quote", async () => {
    const result = await processInboundEmail({
      email: email({
        text: null,
        html: [
          "<html><body>",
          '<div dir="ltr">Here is my reply text</div>',
          '<div class="gmail_quote"><div class="gmail_attr">On Fri, Oct 9, 2026 at 9:53 AM Support wrote:</div><blockquote>thanks oldie</blockquote></div>',
          "</body></html>",
        ].join(""),
        headers: { ...email().headers, messageId: "<quote2@sender>" },
      }),
    });
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    const message = await db.prisma.message.findFirstOrThrow();
    expect(message.body).toBe("Here is my reply text");
    expect(message.channel).toBe("EMAIL");
  });

  it("keeps ambiguous HTML-only content (no confident quote marker)", async () => {
    const result = await processInboundEmail({
      email: email({
        text: null,
        html: "<div>Reply about the invoice</div><div>Original-looking but unmarked text</div>",
        headers: { ...email().headers, messageId: "<quote3@sender>" },
      }),
    });
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    const message = await db.prisma.message.findFirstOrThrow();
    expect(message.body).toBe("Reply about the invoice\nOriginal-looking but unmarked text");
  });

  it("falls back to the no-text placeholder when a reply is nothing but the quoted original", async () => {
    const result = await processInboundEmail({
      email: email({
        text: "On 10/9/2026 9:53 AM, Support wrote:\n> thanks oldie",
        headers: { ...email().headers, messageId: "<quote4@sender>" },
      }),
    });
    if (result.outcome !== "created") throw new Error(JSON.stringify(result));
    const message = await db.prisma.message.findFirstOrThrow();
    expect(message.body).toBe("(no text content)");
  });
});

describe("inbound webhook route", () => {
  it("rejects missing or wrong secrets", async () => {
    const noSecret = await postInbound(jsonEmail(), "");
    expect(noSecret.status).toBe(401);
  });

  it("reads threading headers case-insensitively and from folded strings", async () => {
    // Object shape with mixed-case keys.
    await postInbound(
      jsonEmail({ headers: { "Message-Id": "<case@sender>", "In-Reply-To": "<none@x>" } }),
    );
    expect(await db.prisma.conversation.count()).toBe(1);
    const conversation = await db.prisma.conversation.findFirstOrThrow();
    expect(conversation.emailMessageId).toBe("<case@sender>");

    // Raw folded RFC 822 string shape.
    const response = await postInbound(
      jsonEmail({
        headers: "Message-Id: <fold@sender>\r\nReferences: <case@sender>\r\n more-ids",
      }),
    );
    expect(response.status).toBe(200);
    // Folded references thread into the same conversation.
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count()).toBe(2);
  });

  it("parses quoted display names containing commas", async () => {
    const response = await postInbound(
      jsonEmail({
        from: '"Rivera, Sam" <sam@fastmail.dev>',
        headers: { "Message-ID": "<quoted@sender>" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await db.prisma.conversation.count()).toBe(1);
  });

  it("accepts the JSON bridge shape with the header secret", async () => {
    const response = await postInbound(jsonEmail({ headers: { "Message-ID": "<w@sender>" } }));
    expect(response.status).toBe(200);
    expect(await db.prisma.conversation.count()).toBe(1);
  });

  it("is idempotent across duplicate webhook deliveries", async () => {
    const body = jsonEmail({ headers: { "Message-ID": "<dup@sender>" } });
    await postInbound(body);
    const second = await postInbound(body);
    expect(second.status).toBe(200);
    const payload = (await second.json()) as { duplicate?: boolean };
    expect(payload.duplicate).toBe(true);
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count()).toBe(1);
  });
});

/** Seed the crashed-attempt state: RECEIVED delivery claimed the
 * Message-ID but the message insert (and its completion marker) never
 * committed. */
async function simulateCrashedReply(conversationId: string, crashedMessageId: string) {
  await db.prisma.emailDelivery.create({
    data: {
      workspaceId,
      productId,
      conversationId,
      direction: "INBOUND",
      status: "RECEIVED",
      providerMessageId: crashedMessageId,
      fromAddress: "sam@fastmail.dev",
      toAddress: productInbound,
      subject: "Re: Invoice question",
    },
  });
}

describe("partial-failure recovery (issue #102)", () => {
  it("recovers a threaded reply whose delivery was recorded but whose message never landed", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<root102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    expect(await db.prisma.message.count()).toBe(1);

    await simulateCrashedReply(first.conversationId, "<crash102@sender>");

    // Provider retry: the conversation already has messages — the old
    // "conversation has any message" check acked this as duplicate and
    // dropped the customer's reply.
    const retry = await processInboundEmail({
      email: email({
        text: "Replying after the crash.",
        subject: "Re: Invoice question",
        headers: {
          ...email().headers,
          messageId: "<crash102@sender>",
          inReplyTo: "<root102@sender>",
        },
      }),
    });
    if (retry.outcome !== "created") throw new Error(JSON.stringify(retry));
    expect(retry.conversationId).toBe(first.conversationId);
    expect(await db.prisma.message.count()).toBe(2);
    const messages = await db.prisma.message.findMany({ orderBy: { createdAt: "asc" } });
    expect(messages[1].body).toBe("Replying after the crash.");

    // The completion marker committed together with the message insert.
    const delivery = await db.prisma.emailDelivery.findUniqueOrThrow({
      where: {
        direction_productId_providerMessageId: {
          direction: "INBOUND",
          productId,
          providerMessageId: "<crash102@sender>",
        },
      },
    });
    expect(delivery.messageId).toBe(messages[1].id);

    // A fully processed reply acks further retries as duplicates.
    const again = await processInboundEmail({
      email: email({
        text: "Replying after the crash.",
        subject: "Re: Invoice question",
        headers: {
          ...email().headers,
          messageId: "<crash102@sender>",
          inReplyTo: "<root102@sender>",
        },
      }),
    });
    expect(again.outcome).toBe("duplicate");
    expect(await db.prisma.message.count()).toBe(2);
  });

  it("reuses attachments the crashed attempt already stored instead of duplicating them", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<rootatt102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));

    const data = pngBytes(64, 7);
    const storageKey = inboundAttachmentStorageKey({
      productId,
      providerMessageId: "<crashatt102@sender>",
      index: 0,
      data,
    });
    await simulateCrashedReply(first.conversationId, "<crashatt102@sender>");
    await db.prisma.attachment.create({
      data: {
        workspaceId,
        productId,
        conversationId: first.conversationId,
        filename: "shot.png",
        contentType: "image/png",
        size: data.byteLength,
        storageKey,
      },
    });
    keyedStorage.files.set(storageKey, data);

    const retry = await processInboundEmail({
      email: email({
        text: "Reply with the same screenshot.",
        subject: "Re: Invoice question",
        headers: {
          ...email().headers,
          messageId: "<crashatt102@sender>",
          inReplyTo: "<rootatt102@sender>",
        },
        attachments: [{ filename: "shot.png", contentType: "image/png", data }],
      }),
    });
    if (retry.outcome !== "created") throw new Error(JSON.stringify(retry));
    expect(await db.prisma.attachment.count()).toBe(1);
    const message = await db.prisma.message.findFirstOrThrow({
      where: { conversationId: first.conversationId },
      orderBy: { createdAt: "desc" },
      include: { attachments: true },
    });
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].filename).toBe("shot.png");
  });

  it("marks a normally processed reply's delivery complete", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<rootmark102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const reply = await processInboundEmail({
      email: email({
        text: "Normal reply.",
        headers: {
          ...email().headers,
          messageId: "<replymark102@sender>",
          inReplyTo: "<rootmark102@sender>",
        },
      }),
    });
    if (reply.outcome !== "created") throw new Error(JSON.stringify(reply));
    const delivery = await db.prisma.emailDelivery.findUniqueOrThrow({
      where: {
        direction_productId_providerMessageId: {
          direction: "INBOUND",
          productId,
          providerMessageId: "<replymark102@sender>",
        },
      },
    });
    expect(delivery.messageId).not.toBeNull();
    const marked = await db.prisma.message.findUniqueOrThrow({ where: { id: delivery.messageId! } });
    expect(marked.conversationId).toBe(reply.conversationId);
  });

  it("still recovers a crashed first attempt onto its own conversation", async () => {
    // Crash between the conversation+delivery transaction and the message
    // insert: rewind a completed run to that state.
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<newcrash102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    await db.prisma.message.deleteMany({ where: { conversationId: first.conversationId } });
    await db.prisma.emailDelivery.updateMany({
      where: { providerMessageId: "<newcrash102@sender>" },
      data: { messageId: null },
    });

    const retry = await processInboundEmail({
      email: email({
        text: "Recovered root body.",
        headers: { ...email().headers, messageId: "<newcrash102@sender>" },
      }),
    });
    if (retry.outcome !== "created") throw new Error(JSON.stringify(retry));
    expect(retry.conversationId).toBe(first.conversationId);
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count()).toBe(1);
  });
});

describe("derived Message-ID (no Message-ID header)", () => {
  it("separates identical-text emails with different attachments", async () => {
    const first = await processInboundEmail({
      email: email({
        text: "No id, with a file.",
        headers: { ...email().headers, messageId: null },
        attachments: [{ filename: "a.png", contentType: "image/png", data: pngBytes(64, 1) }],
      }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const second = await processInboundEmail({
      email: email({
        text: "No id, with a file.",
        headers: { ...email().headers, messageId: null },
        attachments: [{ filename: "a.png", contentType: "image/png", data: pngBytes(64, 2) }],
      }),
    });
    if (second.outcome !== "created") throw new Error(JSON.stringify(second));
    expect(await db.prisma.conversation.count()).toBe(2);
  });

  it("stays idempotent for byte-identical redeliveries", async () => {
    const mail = () =>
      email({
        text: "No id, same file.",
        headers: { ...email().headers, messageId: null },
        attachments: [{ filename: "b.png", contentType: "image/png", data: pngBytes(64, 3) }],
      });
    const first = await processInboundEmail({ email: mail() });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const second = await processInboundEmail({ email: mail() });
    expect(second.outcome).toBe("duplicate");
    expect(await db.prisma.conversation.count()).toBe(1);
    expect(await db.prisma.message.count()).toBe(1);
  });
});

describe("reply-token address case", () => {
  it("threads when a mail hop lowercases a mixed-case legacy token", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<rootcase102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    await db.prisma.conversation.update({
      where: { id: first.conversationId },
      data: { emailReplyToken: "LegacyMixedToken" },
    });

    const continued = await processInboundEmail({
      email: email({
        to: ["reply+legacymixedtoken@inbound.localhost"],
        text: "Continuing via the lowercased legacy token.",
        headers: { ...email().headers, messageId: "<legacycase102@sender>" },
      }),
    });
    if (continued.outcome !== "created") throw new Error(JSON.stringify(continued));
    expect(continued.conversationId).toBe(first.conversationId);
  });

  it("threads an uppercased copy of a generated lowercase token", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<rootupper102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const conversation = await db.prisma.conversation.findFirstOrThrow();
    expect(conversation.emailReplyToken).toBe(conversation.emailReplyToken!.toLowerCase());

    const continued = await processInboundEmail({
      email: email({
        to: [`reply+${conversation.emailReplyToken!.toUpperCase()}@inbound.localhost`],
        text: "Continuing via the uppercased token.",
        headers: { ...email().headers, messageId: "<uppercase102@sender>" },
      }),
    });
    if (continued.outcome !== "created") throw new Error(JSON.stringify(continued));
    expect(continued.conversationId).toBe(first.conversationId);
  });
});

describe("JSON bridge body cap", () => {
  it("rejects an oversized (but valid) JSON body without processing it", async () => {
    // Valid JSON well over the cap: without the cap this parses, passes
    // fromJsonBody and creates a conversation.
    const body = `{"from":"Sam Rivera <sam@fastmail.dev>","to":${JSON.stringify(productInbound)},"subject":"big","text":"${"a".repeat(MAX_INBOUND_BYTES)}"}`;
    const request = new NextRequest("http://localhost:3000/api/email/inbound", {
      method: "POST",
      headers: { "content-type": "application/json", [INBOUND_HEADER]: "test-secret" },
      body,
    });
    const response = await inboundPost(request);
    expect(response.status).toBe(400);
    expect(await db.prisma.conversation.count()).toBe(0);
  });
});

describe("transactional completion (CodeRabbit round on PR #107)", () => {
  it("rolls back the losing side of concurrent retries instead of double-posting", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<rootrace102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    await simulateCrashedReply(first.conversationId, "<crashrace102@sender>");

    // Worker A completes the recovery.
    const recovered = await processInboundEmail({
      email: email({
        text: "Recovered by worker A.",
        subject: "Re: Invoice question",
        headers: {
          ...email().headers,
          messageId: "<crashrace102@sender>",
          inReplyTo: "<rootrace102@sender>",
        },
      }),
    });
    if (recovered.outcome !== "created") throw new Error(JSON.stringify(recovered));
    expect(await db.prisma.message.count()).toBe(2);

    // Worker B raced A: it read the delivery row before A marked it, so
    // its early duplicate check is stale. The marker hook must see count 0,
    // throw, and roll B's message insert back.
    const current = await db.prisma.emailDelivery.findUniqueOrThrow({
      where: {
        direction_productId_providerMessageId: {
          direction: "INBOUND",
          productId,
          providerMessageId: "<crashrace102@sender>",
        },
      },
    });
    const spy = vi
      .spyOn(db.prisma.emailDelivery, "findUnique")
      .mockResolvedValueOnce({ ...current, messageId: null });
    await expect(
      processInboundEmail({
        email: email({
          text: "Worker B must not commit this.",
          subject: "Re: Invoice question",
          headers: {
            ...email().headers,
            messageId: "<crashrace102@sender>",
            inReplyTo: "<rootrace102@sender>",
          },
        }),
      }),
    ).rejects.toThrow(InboundRejectError);
    spy.mockRestore();
    expect(await db.prisma.message.count()).toBe(2);
  });

  it("propagates the marker miss as a rejection (never ok:false) with nothing committed", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<roothook102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    await simulateCrashedReply(first.conversationId, "<crashhook102@sender>");
    const recovered = await processInboundEmail({
      email: email({
        text: "Completed once.",
        headers: {
          ...email().headers,
          messageId: "<crashhook102@sender>",
          inReplyTo: "<roothook102@sender>",
        },
      }),
    });
    if (recovered.outcome !== "created") throw new Error(JSON.stringify(recovered));

    // A late caller re-running the marker hook against the already-marked
    // row: rejects, and the message insert rolls back.
    await expect(
      addCustomerMessage({
        workspaceId,
        conversationId: recovered.conversationId,
        body: "This message must not commit.",
        source: { kind: "email", fromEmail: "sam@fastmail.dev" },
        inTransaction: markInboundDeliveryComplete({
          productId,
          providerMessageId: "<crashhook102@sender>",
          conversationId: recovered.conversationId,
        }),
      }),
    ).rejects.toThrow(InboundRejectError);
    expect(await db.prisma.message.count()).toBe(2);
  });

  it("links attachments inside the message transaction, before the completion marker", async () => {
    const first = await processInboundEmail({
      email: email({ headers: { ...email().headers, messageId: "<roottxlink102@sender>" } }),
    });
    if (first.outcome !== "created") throw new Error(JSON.stringify(first));
    const stored = await storeAttachment({
      workspaceId,
      productId,
      conversationId: first.conversationId,
      file: validateAttachment({ name: "in-tx.png", type: "image/png", data: pngBytes(64, 11) }),
    });

    let markerMessageId: string | null = null;
    let linkVisibleToMarker: string | null = null;
    const result = await addCustomerMessage({
      workspaceId,
      conversationId: first.conversationId,
      body: "The attachment link must already hold inside the transaction.",
      source: { kind: "email", fromEmail: "sam@fastmail.dev" },
      attachmentIds: [stored.id],
      inTransaction: async (tx, messageId) => {
        markerMessageId = messageId;
        linkVisibleToMarker =
          (await tx.attachment.findUnique({ where: { id: stored.id } }))?.messageId ?? null;
      },
    });
    expect(result.ok).toBe(true);
    // With the link inside the transaction, the marker hook already sees
    // the attachment bound to the new message — no post-commit window.
    expect(linkVisibleToMarker).toBe(markerMessageId);
    const attachment = await db.prisma.attachment.findUniqueOrThrow({ where: { id: stored.id } });
    expect(attachment.messageId).toBe(markerMessageId);
  });
});
