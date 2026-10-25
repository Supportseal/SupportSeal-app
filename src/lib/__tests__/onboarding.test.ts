import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestUser, startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { prisma } from "@/lib/prisma";
import {
  computeChecklist,
  issueWidgetTestToken,
  resolveWizardState,
  verifyWidgetTestToken,
} from "@/lib/onboarding";
import { allocateTicketNumber } from "@/lib/ticket";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  await db.prisma.emailDelivery.deleteMany();
  await db.prisma.attachment.deleteMany();
  await db.prisma.chatVisitor.deleteMany();
  await db.prisma.message.deleteMany();
  await db.prisma.conversationTag.deleteMany();
  await db.prisma.tag.deleteMany();
  await db.prisma.conversation.deleteMany();
  await db.prisma.contact.deleteMany();
  await db.prisma.savedReply.deleteMany();
  await db.prisma.productDomain.deleteMany();
  await db.prisma.product.deleteMany();
  await db.prisma.invite.deleteMany();
  await db.prisma.membership.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.user.deleteMany();
});

describe("wizard state", () => {
  it("steps from workspace → product → domain → install from real data", () => {
    const ctx = { user: { id: "u", name: "U", email: "u@x.io" }, workspace: { id: "w", name: "W" }, role: "ADMIN" as const };
    expect(resolveWizardState(null, null, false).step).toBe(1);
    expect(resolveWizardState(ctx, null, false).step).toBe(2);
    expect(
      resolveWizardState(ctx, { id: "p", name: "P", primaryColor: "#2563eb", widgetPublicKey: "pk" }, false).step,
    ).toBe(3);
    expect(
      resolveWizardState(ctx, { id: "p", name: "P", primaryColor: "#2563eb", widgetPublicKey: "pk" }, true).step,
    ).toBe(4);
  });
});

describe("checklist derivation", () => {
  it("derives every item from real workspace data", async () => {
    const user = await createTestUser(db.prisma, { email: "founder@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Acme", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    const product = await prisma.product.create({
      data: { workspaceId: workspace.id, name: "Alpha", widgetPublicKey: "pk_ob1", domains: { create: { domain: "app.alpha.dev" } } },
    });

    let state = await computeChecklist(workspace.id);
    // A domain row alone does not complete "Install the widget": the widget
    // has not demonstrably run yet (design table row 1: done when a config
    // request arrives from an allowed origin, or item 2 completes).
    expect(state.items.find((i) => i.id === "install")?.done).toBe(false);
    expect(state.items.find((i) => i.id === "test-message")?.done).toBe(false);
    expect(state.doneCount).toBe(0);
    expect(state.items.filter((i) => i.required).map((i) => i.id)).toEqual(["install", "test-message"]);

    // Issue #45: the email item deep-links to the Product's Email tab.
    const emailItem = state.items.find((i) => i.id === "email");
    expect(emailItem?.actionHref).toBe(`/settings/products/${product.id}?tab=email`);
    expect(emailItem?.done).toBe(false);

    const contact = await prisma.contact.create({ data: { workspaceId: workspace.id, email: null } });
    const conversation = await prisma.conversation.create({
      data: { workspaceId: workspace.id, ticketNumber: await allocateTicketNumber(prisma, workspace.id), productId: product.id, contactId: contact.id, channel: "CHAT" },
    });
    await prisma.message.create({ data: { conversationId: conversation.id, kind: "CUSTOMER", body: "hi" } });

    state = await computeChecklist(workspace.id);
    // The first conversation completes item 2 and, with it, item 1 — even
    // though the Product's only domain was never used to embed anything.
    // This is the flow that used to wedge the checklist at 5/6: workspaces
    // that skip the domain step and test via the hosted test page (which
    // adds no allowlist entry) never produced a domain-only signal.
    expect(state.items.find((i) => i.id === "install")?.done).toBe(true);
    expect(state.items.find((i) => i.id === "test-message")?.done).toBe(true);
    expect(state.items.find((i) => i.id === "reply")?.done).toBe(false);

    await prisma.message.create({ data: { conversationId: conversation.id, kind: "AGENT", body: "hello", agentUserId: user.id } });
    await prisma.emailDelivery.create({
      data: { workspaceId: workspace.id, productId: product.id, direction: "INBOUND", status: "RECEIVED", providerMessageId: "<m1>" },
    });
    await prisma.product.create({ data: { workspaceId: workspace.id, name: "Beta", widgetPublicKey: "pk_ob2" } });
    await prisma.invite.create({
      data: { workspaceId: workspace.id, email: "agent@example.com", role: "AGENT", tokenHash: "t".repeat(64), invitedById: user.id, expiresAt: new Date(Date.now() + 60000) },
    });

    state = await computeChecklist(workspace.id);
    expect(state.doneCount).toBe(state.total);
  });

  it("completes 'Install the widget' (only) from a recorded widget load", async () => {
    const user = await createTestUser(db.prisma, { email: "loader@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Loaded", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    const product = await prisma.product.create({
      data: { workspaceId: workspace.id, name: "One", widgetPublicKey: "pk_l1" },
    });
    await prisma.widgetHostSignal.create({
      data: { productId: product.id, host: "bad.example.net", outcome: "REJECTED", lastSeenAt: new Date() },
    });
    let state = await computeChecklist(workspace.id);
    expect(state.items.find((i) => i.id === "install")?.done).toBe(false);

    await prisma.widgetHostSignal.create({
      data: { productId: product.id, host: "app.example.com", outcome: "LOADED", lastSeenAt: new Date() },
    });
    state = await computeChecklist(workspace.id);
    expect(state.items.find((i) => i.id === "install")?.done).toBe(true);
    expect(state.items.find((i) => i.id === "test-message")?.done).toBe(false);
  });

  it("falls back to the Products list when no product exists yet", async () => {
    const user = await createTestUser(db.prisma, { email: "solo@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Empty", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    const state = await computeChecklist(workspace.id);
    expect(state.items.find((i) => i.id === "email")?.actionHref).toBe("/settings/products");
  });

  it("completes with no domain rows at all (skip-domains + hosted test page flow)", async () => {
    // Regression: "Install the widget" was keyed on domain count, so a
    // workspace that skipped the domain step and tested via the signed
    // test-token page (no allowlist entry) sat at 5/6 forever.
    const user = await createTestUser(db.prisma, { email: "skipper@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "SkipDomains", memberships: { create: { userId: user.id, role: "ADMIN" } } },
    });
    const product = await prisma.product.create({
      data: { workspaceId: workspace.id, name: "One", widgetPublicKey: "pk_d1" },
    });
    const contact = await prisma.contact.create({ data: { workspaceId: workspace.id, email: null } });
    const conversation = await prisma.conversation.create({
      data: { workspaceId: workspace.id, ticketNumber: await allocateTicketNumber(prisma, workspace.id), productId: product.id, contactId: contact.id, channel: "CHAT" },
    });
    await prisma.message.create({ data: { conversationId: conversation.id, kind: "CUSTOMER", body: "hello" } });
    await prisma.message.create({
      data: { conversationId: conversation.id, kind: "AGENT", body: "hi there", agentUserId: user.id },
    });
    await prisma.emailDelivery.create({
      data: { workspaceId: workspace.id, productId: product.id, direction: "INBOUND", status: "RECEIVED", providerMessageId: "<d1>" },
    });
    await prisma.product.create({
      data: { workspaceId: workspace.id, name: "Two", widgetPublicKey: "pk_d2" },
    });
    await prisma.invite.create({
      data: { workspaceId: workspace.id, email: "agent2@example.com", role: "AGENT", tokenHash: "d".repeat(64), invitedById: user.id, expiresAt: new Date(Date.now() + 60000) },
    });

    const state = await computeChecklist(workspace.id);
    expect(state.doneCount).toBe(state.total);
  });
});

describe("checklist: invite a teammate", () => {
  it("is done once a teammate has joined, even without a surviving invite row", async () => {
    const owner = await createTestUser(db.prisma, { email: "owner@example.com" });
    const teammate = await createTestUser(db.prisma, { email: "mate@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Solo", memberships: { create: { userId: owner.id, role: "ADMIN" } } },
    });
    let state = await computeChecklist(workspace.id);
    expect(state.items.find((i) => i.id === "invite")?.done).toBe(false);

    await db.prisma.membership.create({
      data: { userId: teammate.id, workspaceId: workspace.id, role: "AGENT" },
    });
    state = await computeChecklist(workspace.id);
    expect(state.items.find((i) => i.id === "invite")?.done).toBe(true);
  });

  it("stays done after an invite is accepted, and open again if the only invite is revoked", async () => {
    const owner = await createTestUser(db.prisma, { email: "owner2@example.com" });
    const workspace = await db.prisma.workspace.create({
      data: { name: "Invites", memberships: { create: { userId: owner.id, role: "ADMIN" } } },
    });
    const invite = await db.prisma.invite.create({
      data: {
        workspaceId: workspace.id,
        email: "later@example.com",
        role: "AGENT",
        tokenHash: "e".repeat(64),
        invitedById: owner.id,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const done = async () =>
      (await computeChecklist(workspace.id)).items.find((i) => i.id === "invite")?.done;

    // Sent but pending, then accepted: the invite row survives with acceptedAt.
    expect(await done()).toBe(true);
    await db.prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    expect(await done()).toBe(true);

    // Revoked before anyone joined: nothing was sent that still stands.
    await db.prisma.invite.delete({ where: { id: invite.id } });
    expect(await done()).toBe(false);
  });
});

describe("widget test tokens (design D8)", () => {
  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = "token-test-secret";
  });
  afterAll(() => {
    delete process.env.BETTER_AUTH_SECRET;
  });
  it("refuses to issue without a configured secret", async () => {
    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.INBOUND_WEBHOOK_SECRET;
    const { issueWidgetTestToken: issue } = await import("@/lib/onboarding");
    const disabled = issue("prod-x");
    expect(disabled.token).toBe("");
    process.env.BETTER_AUTH_SECRET = saved;
  });
  it("round-trips for the issued product and expires", () => {
    const { token } = issueWidgetTestToken("prod-1");
    expect(verifyWidgetTestToken(token, "prod-1")).toBe(true);
    expect(verifyWidgetTestToken(token, "prod-2")).toBe(false);
    expect(verifyWidgetTestToken(`${token}x`, "prod-1")).toBe(false);
    expect(verifyWidgetTestToken(null, "prod-1")).toBe(false);
  });

  it("rejects expired tokens", async () => {
    process.env.BETTER_AUTH_SECRET = "fixed-secret-for-test";
    const { verifyWidgetTestToken: verify } = await import("@/lib/onboarding");
    const { issueWidgetTestToken: issue } = await import("@/lib/onboarding");
    // issue with a tiny TTL by faking expiry: craft directly
    const { createHmac } = await import("node:crypto");
    const payload = `prod-1|${Date.now() - 1000}`;
    const mac = createHmac("sha256", "fixed-secret-for-test").update(payload).digest("base64url");
    const token = `${Buffer.from(payload).toString("base64url")}.${mac}`;
    expect(verify(token, "prod-1")).toBe(false);
    const fresh = issue("prod-1");
    expect(verify(fresh.token, "prod-1")).toBe(true);
    delete process.env.BETTER_AUTH_SECRET;
  });
});
