import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import type { Prisma } from "@/generated/prisma/client";

import { POST } from "@/app/api/widget/form/route";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { type WorkspaceContext } from "@/lib/workspace";
import { createProduct, rotateProductFormKey } from "@/lib/products";
import { PRISMA_TEST_CLIENT_GLOBAL_KEY } from "@/lib/prisma-constants";
import { createFormConversation, loadFormProduct } from "@/lib/widget";
import { formatTicketRef } from "@/lib/ticket";
import { WIDGET_RATE_LIMITS } from "@/lib/widget-rate-limit";

/**
 * Issue #154: the keyed contact-form endpoint. A per-Product public form
 * key (`fk_…`) presented by a server-side form handler creates a
 * Conversation with an explicit contact email — no cookie/Origin gates, no
 * visitor session. The key scopes the Product (ADR-0001): posts land in the
 * key's own Workspace only, archived Products are invisible, and rotation
 * cuts off the previous key immediately.
 */

let db: TestDb;
let ctx: WorkspaceContext;
let workspaceId: string;
let formKey: string;
let widgetKey: string;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.conversationTag.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();

  const user = { id: `u_${Date.now()}`, name: "Founder", email: "founder@example.com" };
  await db.prisma.user.create({ data: { ...user, emailVerified: false } });
  const workspace = await db.prisma.workspace.create({ data: { name: "Acme" } });
  await db.prisma.membership.create({
    data: { userId: user.id, workspaceId: workspace.id, role: "ADMIN" },
  });
  ctx = {
    user,
    workspace: { id: workspace.id, name: "Acme" },
    role: "ADMIN",
  };
  workspaceId = workspace.id;
  const product = await createProduct({ ctx, name: "PM Toolkit", domains: ["app.pmtoolkit.dev"] });
  if (!product.ok) throw new Error(product.error);
  formKey = product.product.formPublicKey!;
  widgetKey = product.product.widgetPublicKey;
});

function formRequest(input: { ip: string; key?: string; body?: unknown; queryKey?: boolean }) {
  const url = new URL("http://localhost:3000/api/widget/form");
  const headers = new Headers({
    "content-type": "application/json",
    "x-forwarded-for": input.ip,
  });
  const key = input.key ?? formKey;
  if (!input.queryKey) headers.set("x-ss-form-key", key);
  else url.searchParams.set("key", key);
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(input.body ?? { email: "sam@example.com", message: "I cannot log in." }),
  });
}

describe("POST /api/widget/form (issue #154)", () => {
  it("creates a Conversation with the explicit contact email and a CHAT message", async () => {
    const response = await POST(
      formRequest({
        ip: "1.1.1.1",
        body: {
          email: "Sam@Example.com",
          name: "Sam Visitor",
          subject: "  Login issue  ",
          message: "  I cannot log in since yesterday.  ",
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    const conversation = await db.prisma.conversation.findFirstOrThrow({
      where: { workspaceId },
      include: { contact: true, messages: true },
    });
    expect(conversation.channel).toBe("CHAT");
    expect(conversation.subject).toBe("Login issue");
    expect(conversation.contact.email).toBe("sam@example.com");
    expect(conversation.contact.name).toBe("Sam Visitor");
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({ kind: "CUSTOMER", body: "I cannot log in since yesterday." });
    expect(body.ticketRef).toBe(formatTicketRef(conversation.ticketNumber));
  });

  it("accepts the key via the ?key= query parameter", async () => {
    const response = await POST(formRequest({ ip: "1.1.1.2", key: formKey, queryKey: true }));
    expect(response.status).toBe(200);
    expect(await db.prisma.conversation.count({ where: { workspaceId } })).toBe(1);
  });

  it("rejects an invalid key, a widget key and an archived Product", async () => {
    expect((await POST(formRequest({ ip: "1.1.1.3", key: "fk_nope" }))).status).toBe(404);
    expect((await POST(formRequest({ ip: "1.1.1.3", key: widgetKey }))).status).toBe(404);
    expect((await POST(formRequest({ ip: "1.1.1.3", key: "pk_" }))).status).toBe(404);

    const archived = await createProduct({ ctx, name: "Legacy" });
    if (!archived.ok) throw new Error(archived.error);
    await db.prisma.product.update({
      where: { id: archived.product.id },
      data: { archivedAt: new Date() },
    });
    expect(
      (await POST(formRequest({ ip: "1.1.1.3", key: archived.product.formPublicKey! }))).status,
    ).toBe(404);
    expect(await db.prisma.conversation.count()).toBe(0);
  });

  it("validates the payload", async () => {
    expect(
      (await POST(formRequest({ ip: "1.1.1.4", body: { message: "no email" } }))).status,
    ).toBe(400);
    expect(
      (await POST(formRequest({ ip: "1.1.1.4", body: { email: "sam@example.com" } }))).status,
    ).toBe(400);
    const invalidEmail = await POST(
      formRequest({ ip: "1.1.1.4", body: { email: "not-an-email", message: "hello" } }),
    );
    expect(invalidEmail.status).toBe(400);
    expect(await invalidEmail.json()).toEqual({ error: "Enter a valid email address." });
    const emptyMessage = await POST(
      formRequest({ ip: "1.1.1.4", body: { email: "sam@example.com", message: "   " } }),
    );
    expect(emptyMessage.status).toBe(400);
    expect(await emptyMessage.json()).toEqual({ error: "Message is empty." });
    for (const body of [
      { email: 42, message: "hello" },
      { email: "sam@example.com", message: { text: "hello" } },
      { email: "sam@example.com", message: "hello", name: 7 },
      { email: "sam@example.com", message: "hello", subject: ["x"] },
    ]) {
      const response = await POST(formRequest({ ip: "1.1.1.4", body }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
    }
    expect(await db.prisma.conversation.count()).toBe(0);
  });

  it("keeps Workspace isolation: a key only creates Conversations in its own Workspace", async () => {
    const betaUser = { id: "u_beta_form", name: "Beta", email: "beta@example.com" };
    await db.prisma.user.create({ data: { ...betaUser, emailVerified: false } });
    const beta = await db.prisma.workspace.create({ data: { name: "Beta" } });
    await db.prisma.membership.create({
      data: { userId: betaUser.id, workspaceId: beta.id, role: "ADMIN" },
    });
    const betaProduct = await createProduct({
      ctx: {
        user: betaUser,
        workspace: { id: beta.id, name: "Beta" },
        role: "ADMIN",
      },
      name: "Beta Tool",
    });
    if (!betaProduct.ok) throw new Error(betaProduct.error);

    // Both keys work, each strictly inside its own Workspace.
    expect((await POST(formRequest({ ip: "1.1.1.5", key: formKey }))).status).toBe(200);
    expect((await POST(formRequest({ ip: "1.1.1.5", key: betaProduct.product.formPublicKey! }))).status).toBe(200);
    expect(await db.prisma.conversation.count({ where: { workspaceId } })).toBe(1);
    expect(await db.prisma.conversation.count({ where: { workspaceId: beta.id } })).toBe(1);

    // Every contact and conversation stays inside the posting key's Workspace.
    const alphaEmails = await db.prisma.contact.findMany({ where: { workspaceId } });
    expect(alphaEmails).toHaveLength(1);
  });

  it("rotation cuts off the previous key immediately", async () => {
    const rotated = await rotateProductFormKey({
      ctx,
      productId: (await db.prisma.product.findFirstOrThrow({ where: { workspaceId } })).id,
    });
    if (!rotated.ok) throw new Error(rotated.error);
    expect(rotated.formPublicKey).toMatch(/^fk_/u);
    expect(rotated.formPublicKey).not.toBe(formKey);

    expect((await POST(formRequest({ ip: "1.1.1.6", key: formKey }))).status).toBe(404);
    const response = await POST(formRequest({ ip: "1.1.1.6", key: rotated.formPublicKey }));
    expect(response.status).toBe(200);
    expect(await db.prisma.conversation.count({ where: { workspaceId } })).toBe(1);
  });

  it("rejects an in-flight request whose key was rotated after the lookup", async () => {
    const product = await db.prisma.product.findFirstOrThrow({ where: { workspaceId } });
    const loaded = await loadFormProduct(formKey);
    if (!loaded) throw new Error("form key should resolve before rotation");
    const rotated = await rotateProductFormKey({ ctx, productId: product.id });
    if (!rotated.ok) throw new Error(rotated.error);

    const result = await createFormConversation({
      product: loaded,
      email: "sam@example.com",
      message: "Sent just before the rotation committed.",
    });
    // productGone makes the route answer 404 not_found, like the lookup does.
    expect(result).toMatchObject({ ok: false, productGone: true });
    expect(await db.prisma.conversation.count({ where: { workspaceId } })).toBe(0);
  });

  it("rejects an over-long message with 400 instead of truncating it", async () => {
    const response = await POST(
      formRequest({ ip: "1.1.1.10", body: { email: "sam@example.com", message: "x".repeat(5001) } }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Message is too long (max 5000 characters)." });
    expect(await db.prisma.conversation.count()).toBe(0);
  });

  it("rejects an over-long contact email with 400", async () => {
    const email = `${"a".repeat(250)}@example.com`;
    const response = await POST(formRequest({ ip: "1.1.1.9", body: { email, message: "Hi" } }));
    expect(response.status).toBe(400);
    expect(await db.prisma.contact.count({ where: { workspaceId } })).toBe(0);
  });

  it("caps submissions per IP before touching the database", async () => {
    const ip = "1.1.1.7";
    for (let i = 0; i < WIDGET_RATE_LIMITS.formSubmission; i++) {
      const response = await POST(formRequest({ ip, key: formKey }));
      expect(response.status).toBe(200);
    }
    const over = await POST(formRequest({ ip, key: formKey }));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(await db.prisma.conversation.count({ where: { workspaceId } })).toBe(
      WIDGET_RATE_LIMITS.formSubmission,
    );
    // The cap is per IP, not global.
    expect((await POST(formRequest({ ip: "1.1.1.8", key: formKey }))).status).toBe(200);
  });

  it("rejects the Product's own support and inbound addresses as the contact email", async () => {
    const product = await db.prisma.product.findFirstOrThrow({ where: { workspaceId } });
    // Dotted addresses: in the test env the auto-allocated inboundEmail sits
    // on a dotless domain (localhost fallback), which plain email validation
    // already rejects — set a realistic one so the guard itself is tested.
    const inboundEmail = "product_fixture@inbound.example.org";
    await db.prisma.product.update({
      where: { id: product.id },
      data: { supportEmail: "support@pmtoolkit.dev", inboundEmail },
    });

    // Review of #154: submitting the Product's own address would make agent
    // replies re-ingest (mail loop); refuse it at the source, like the
    // widget email capture does (setVisitorEmail). Matching is
    // case-insensitive.
    for (const email of [inboundEmail, "support@pmtoolkit.dev", "SUPPORT@PMToolkit.dev"]) {
      const response = await POST(formRequest({ ip: "1.1.1.9", body: { email, message: "hello" } }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "That is this team's own support address. Enter your own email address.",
      });
    }
    expect(await db.prisma.conversation.count()).toBe(0);
    expect(await db.prisma.contact.count()).toBe(0);
  });

  it("leaves no empty Conversation behind when the first message insert fails", async () => {
    const product = await db.prisma.product.findFirstOrThrow({ where: { workspaceId } });
    const workspaceBefore = await db.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { nextTicketNumber: true },
    });

    // Review of #154: conversation creation and the first message insert
    // share one transaction. Sabotage only the message insert inside the
    // transaction — if the two were separate, an orphaned empty
    // Conversation (already counted for usage) would survive.
    //
    // The app-wide `prisma` is a Proxy that resolves the client from a
    // globalThis key on every property access, so the injection swaps that
    // global for a wrapper whose interactive $transaction callback sees a
    // transaction client with a failing `message.create`.
    const boom = new Error("injected: message insert failed");
    const globals = globalThis as unknown as Record<string, unknown>;
    const realClient = db.prisma;
    const sabotaged = new Proxy(realClient, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          const originalTx = target.$transaction.bind(target);
          return (((arg: unknown, options?: unknown) => {
            if (typeof arg !== "function") return originalTx(arg as never, options as never);
            return originalTx(
              (tx: Prisma.TransactionClient) =>
                (arg as (tx: Prisma.TransactionClient) => Promise<unknown>)(
                  withFailingMessageCreate(tx, boom),
                ),
              options as never,
            );
          }) as typeof target.$transaction);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    globals[PRISMA_TEST_CLIENT_GLOBAL_KEY] = sabotaged;
    try {
      await expect(
        createFormConversation({
          product: { id: product.id, workspaceId, supportEmail: null, inboundEmail: null, formPublicKey: formKey },
          email: "sam@example.com",
          message: "I cannot log in.",
        }),
      ).rejects.toThrow(boom);
    } finally {
      globals[PRISMA_TEST_CLIENT_GLOBAL_KEY] = realClient;
    }

    expect(await db.prisma.conversation.count()).toBe(0);
    expect(await db.prisma.message.count()).toBe(0);
    // The ticket allocation rolled back with the conversation.
    expect(
      await db.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { nextTicketNumber: true },
      }),
    ).toEqual(workspaceBefore);
    // The contact upsert is deliberately outside the transaction (same as
    // the inbound email path): a surviving contact row is not an orphan.
    expect(await db.prisma.contact.count()).toBe(1);
  });
});

/** Real transaction client, but `message.create` rejects with `error`. */
function withFailingMessageCreate(tx: Prisma.TransactionClient, error: Error): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "message") {
        const model = target.message;
        return new Proxy(model, {
          get(modelTarget, modelProp) {
            if (modelProp === "create") return () => Promise.reject(error);
            const value = Reflect.get(modelTarget, modelProp);
            return typeof value === "function" ? value.bind(modelTarget) : value;
          },
        });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Prisma.TransactionClient;
}
