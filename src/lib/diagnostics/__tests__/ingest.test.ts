import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { type WorkspaceContext } from "@/lib/workspace";
import { createProduct, setProductDiagnostics } from "@/lib/products";
import { addAgentMessage, upsertContact, createConversation } from "@/lib/conversations";
import {
  createVisitorSession,
  loadWidgetProduct,
  visitorListMessages,
  visitorSendMessage,
} from "@/lib/widget";
import {
  deleteAllSnapshotsForProduct,
  countSnapshotsForProduct,
  DIAGNOSTICS_MAX_PER_CONVERSATION,
  hasExpiredSnapshotsForConversation,
  listSnapshotsForConversation,
} from "@/lib/diagnostics/store";

let db: TestDb;
let ctx: WorkspaceContext;
let agentCtx: WorkspaceContext;
let otherCtx: WorkspaceContext;
let productId: string;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

function snapshotPayload() {
  const now = Date.now();
  return {
    schemaVersion: 1,
    environment: {
      pageUrl: "https://app.example.com/reports",
      viewportWidth: 1280,
      viewportHeight: 800,
      devicePixelRatio: 2,
    },
    events: [
      {
        kind: "js_error",
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'id')",
        frames: [{ fn: "loadReport", file: "https://app.example.com/app.js", line: 412, col: 19 }],
        pagePath: "/reports",
        firstSeen: now - 5_000,
        lastSeen: now - 5_000,
        count: 3,
      },
      {
        kind: "network",
        method: "GET",
        url: "https://api.example.com/reports",
        status: 500,
        firstSeen: now - 40_000,
        lastSeen: now - 40_000,
        count: 1,
      },
    ],
    droppedCount: 2,
  };
}

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  visitorSession = null;
  const prisma = db.prisma as unknown as Record<
    string,
    { deleteMany: () => Promise<unknown> }
  >;
  for (const model of [
    "diagnosticSnapshot",
    "chatVisitor",
    "conversationTag",
    "message",
    "conversation",
    "contact",
    "productDomain",
    "product",
    "invite",
    "membership",
    "workspace",
    "user",
  ]) {
    await prisma[model].deleteMany();
  }

  const admin = { id: `admin_${Date.now()}`, name: "Founder", email: "founder@example.com" };
  const agent = { id: `agent_${Date.now()}`, name: "Agnet", email: "agent@example.com" };
  const other = { id: `other_${Date.now()}`, name: "Rival", email: "rival@example.com" };
  for (const user of [admin, agent, other]) {
    await db.prisma.user.create({ data: { ...user, emailVerified: false } });
  }
  const workspace = await db.prisma.workspace.create({ data: { name: "Acme" } });
  const rivalWorkspace = await db.prisma.workspace.create({ data: { name: "Rival" } });
  await db.prisma.membership.create({
    data: { userId: admin.id, workspaceId: workspace.id, role: "ADMIN" },
  });
  await db.prisma.membership.create({
    data: { userId: agent.id, workspaceId: workspace.id, role: "AGENT" },
  });
  await db.prisma.membership.create({
    data: { userId: other.id, workspaceId: rivalWorkspace.id, role: "ADMIN" },
  });
  ctx = { user: admin, workspace: { id: workspace.id, name: "Acme" }, role: "ADMIN" };
  agentCtx = { user: agent, workspace: ctx.workspace, role: "AGENT" };
  otherCtx = { user: other, workspace: { id: rivalWorkspace.id, name: "Rival" }, role: "ADMIN" };

  const product = await createProduct({ ctx, name: "PM Toolkit", domains: ["app.pmtoolkit.dev"] });
  if (!product.ok) throw new Error(product.error);
  productId = product.product.id;
});

/** One visitor session per test: all sends land in the same conversation. */
let visitorSession: Awaited<ReturnType<typeof createVisitorSession>>["session"] | null = null;

async function sendMessageWithDiagnostics(diagnostics: unknown) {
  const loaded = (await loadWidgetProduct(
    (await db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).widgetPublicKey,
  ))!;
  if (!visitorSession) {
    visitorSession = (await createVisitorSession(loaded, "app.pmtoolkit.dev")).session;
  }
  return visitorSendMessage({
    product: loaded,
    visitor: visitorSession,
    body: `Message ${Math.random().toString(36).slice(2, 8)}`,
    diagnostics,
    userAgent: UA,
  });
}

describe("diagnostics ingest (DX-01, DX-07, DX-12)", () => {
  it("is off by default: message stored, diagnostics rejected as disabled", async () => {
    const result = await sendMessageWithDiagnostics(snapshotPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual({ status: "rejected", reason: "disabled" });
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(0);
    expect(await db.prisma.message.count()).toBe(1);
  });

  it("attaches a snapshot to the customer message once enabled", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    const result = await sendMessageWithDiagnostics(snapshotPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual({ status: "attached" });

    const row = await db.prisma.diagnosticSnapshot.findFirstOrThrow();
    const message = await db.prisma.message.findFirstOrThrow();
    expect(row.messageId).toBe(message.id);
    expect(row.errorCount).toBe(1);
    expect(row.networkFailureCount).toBe(1);
    expect(row.droppedCount).toBe(2);
    expect((row.environment as Record<string, unknown>).browser).toBe("Chrome 129");
    expect((row.environment as Record<string, unknown>).os).toBe("Windows 10");
    expect((row.environment as Record<string, unknown>).appVersion).toBe("Not provided");
    const retentionMs = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(retentionMs).toBeGreaterThanOrEqual(29 * 24 * 3600 * 1000);
    expect(retentionMs).toBeLessThanOrEqual(31 * 24 * 3600 * 1000);
  });

  it("copies the app version from the visitor's developer context at attach time", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    await sendMessageWithDiagnostics(undefined);
    const visitor = await db.prisma.chatVisitor.findFirstOrThrow();
    await db.prisma.chatVisitor.update({
      where: { id: visitor.id },
      data: { devContext: { appVersion: "2.4.1", updatedAt: new Date().toISOString() } },
    });
    const result = await sendMessageWithDiagnostics(snapshotPayload());
    expect(result.ok).toBe(true);
    const row = await db.prisma.diagnosticSnapshot.findFirstOrThrow();
    expect((row.environment as Record<string, unknown>).appVersion).toBe("2.4.1");
  });

  it("invalid diagnostics never reject the message", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    const result = await sendMessageWithDiagnostics({ nonsense: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual({ status: "rejected", reason: "invalid" });
    expect(await db.prisma.message.count()).toBe(1);
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(0);
  });

  it("disabling rejects the next snapshot at once (DX-14)", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    await setProductDiagnostics({ ctx, productId, enabled: false });
    const result = await sendMessageWithDiagnostics(snapshotPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual({ status: "rejected", reason: "disabled" });
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(0);
  });

  it("never exposes snapshots to the visitor thread (DX-12)", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    await sendMessageWithDiagnostics(snapshotPayload());
    const loaded = (await loadWidgetProduct(
      (await db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).widgetPublicKey,
    ))!;
    const visitor = await db.prisma.chatVisitor.findFirstOrThrow();
    const thread = await visitorListMessages({
      product: loaded,
      visitor: {
        visitorId: visitor.id,
        productId: productId,
        email: null,
        name: null,
        conversationId: visitor.conversationId,
        origin: "app.pmtoolkit.dev",
      },
    });
    const serialized = JSON.stringify(thread);
    expect(serialized).not.toContain("diagnostics");
    expect(serialized).not.toContain("snapshot");
  });
});

describe("diagnostics storage boundaries (DX-11, DX-13)", () => {
  it("caps snapshots per conversation at 100 and reports limit", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    const first = await sendMessageWithDiagnostics(snapshotPayload());
    if (!first.ok) throw new Error(first.error);
    const conversationId = first.conversationId;
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(1);

    const events = [{ kind: "warning", message: "w", firstSeen: Date.now(), lastSeen: Date.now(), count: 1 }];
    const environment = {
      pageUrl: "https://a.com/",
      viewportWidth: 1,
      viewportHeight: 1,
      devicePixelRatio: 1,
      appVersion: "Not provided",
      browser: "Chrome 129",
      os: "Windows 10",
    };
    for (let i = 0; i < DIAGNOSTICS_MAX_PER_CONVERSATION - 1; i++) {
      const message = await db.prisma.message.create({
        data: { conversationId, kind: "CUSTOMER", body: `m${i}` },
      });
      await db.prisma.diagnosticSnapshot.create({
        data: {
          workspaceId: ctx.workspace.id,
          productId,
          conversationId,
          messageId: message.id,
          schemaVersion: 1,
          environment,
          events,
          errorCount: 0,
          warningCount: 1,
          networkFailureCount: 0,
          droppedCount: 0,
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        },
      });
    }

    const result = await sendMessageWithDiagnostics(snapshotPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual({ status: "rejected", reason: "limit" });
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(DIAGNOSTICS_MAX_PER_CONVERSATION);
  });

  it("hides expired snapshots on read and reports the expired state", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    await sendMessageWithDiagnostics(snapshotPayload());
    const row = await db.prisma.diagnosticSnapshot.findFirstOrThrow();
    const workspaceId = ctx.workspace.id;

    expect(await listSnapshotsForConversation(workspaceId, row.conversationId)).toHaveLength(1);
    expect(await hasExpiredSnapshotsForConversation(workspaceId, row.conversationId)).toBe(false);

    await db.prisma.diagnosticSnapshot.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await listSnapshotsForConversation(workspaceId, row.conversationId)).toHaveLength(0);
    expect(await hasExpiredSnapshotsForConversation(workspaceId, row.conversationId)).toBe(true);
  });

  it("purges up to 100 expired snapshots for the product on ingest", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    const contact = await upsertContact({ workspaceId: ctx.workspace.id, email: null, name: null });
    const conversation = await createConversation({
      workspaceId: ctx.workspace.id,
      productId,
      contactId: contact.id,
      channel: "CHAT",
    });
    if (!conversation.ok) throw new Error(conversation.error);

    const expiredAt = new Date(Date.now() - 1000);
    for (let i = 0; i < 3; i++) {
      const message = await db.prisma.message.create({
        data: { conversationId: conversation.conversationId, kind: "CUSTOMER", body: `old${i}` },
      });
      await db.prisma.diagnosticSnapshot.create({
        data: {
          workspaceId: ctx.workspace.id,
          productId,
          conversationId: conversation.conversationId,
          messageId: message.id,
          schemaVersion: 1,
          environment: {},
          events: [],
          errorCount: 0,
          warningCount: 0,
          networkFailureCount: 0,
          droppedCount: 0,
          expiresAt: expiredAt,
        },
      });
    }

    // The next attach purges those expired rows for this product.
    await sendMessageWithDiagnostics(snapshotPayload());
    const remaining = await db.prisma.diagnosticSnapshot.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("cascades from message, conversation and product (DX-13)", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    await sendMessageWithDiagnostics(snapshotPayload());
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(1);

    const row = await db.prisma.diagnosticSnapshot.findFirstOrThrow();
    await db.prisma.message.delete({ where: { id: row.messageId } });
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(0);

    await sendMessageWithDiagnostics(snapshotPayload());
    const second = await db.prisma.diagnosticSnapshot.findFirstOrThrow();
    await db.prisma.conversation.delete({ where: { id: second.conversationId } });
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(0);

    await sendMessageWithDiagnostics(snapshotPayload());
    await db.prisma.product.delete({ where: { id: productId } });
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(0);
  });

  it("delete-all removes every snapshot for the product, messages untouched", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    await sendMessageWithDiagnostics(snapshotPayload());
    expect(await countSnapshotsForProduct(ctx.workspace.id, productId)).toBe(1);

    const removed = await deleteAllSnapshotsForProduct(ctx.workspace.id, productId);
    expect(removed).toBe(1);
    expect(await countSnapshotsForProduct(ctx.workspace.id, productId)).toBe(0);
    expect(await db.prisma.message.count()).toBe(1);
  });
});

describe("diagnostics admin and isolation (DX-02, DX-12)", () => {
  it("records who enabled diagnostics and clears it on disable", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    const product = await db.prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.diagnosticsEnabledAt).not.toBeNull();
    expect(product.diagnosticsEnabledById).toBe(ctx.user.id);

    await setProductDiagnostics({ ctx, productId, enabled: false });
    const disabled = await db.prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(disabled.diagnosticsEnabledAt).toBeNull();
    expect(disabled.diagnosticsEnabledById).toBeNull();
  });

  it("rejects agents and cross-workspace admins", async () => {
    const agent = await setProductDiagnostics({ ctx: agentCtx, productId, enabled: true });
    expect(agent).toEqual({ ok: false, error: "Only Workspace admins can manage Products." });
    expect(
      (await db.prisma.product.findUniqueOrThrow({ where: { id: productId } })).diagnosticsEnabledAt,
    ).toBeNull();

    const cross = await setProductDiagnostics({ ctx: otherCtx, productId, enabled: true });
    expect(cross).toEqual({ ok: false, error: "Product not found." });
  });

  it("never returns another workspace's snapshots", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    await sendMessageWithDiagnostics(snapshotPayload());
    const row = await db.prisma.diagnosticSnapshot.findFirstOrThrow();

    expect(await listSnapshotsForConversation(otherCtx.workspace.id, row.conversationId)).toEqual([]);
    expect(await hasExpiredSnapshotsForConversation(otherCtx.workspace.id, row.conversationId)).toBe(false);
    expect(await countSnapshotsForProduct(otherCtx.workspace.id, productId)).toBe(0);
    expect(await deleteAllSnapshotsForProduct(otherCtx.workspace.id, productId)).toBe(0);
    expect(await db.prisma.diagnosticSnapshot.count()).toBe(1);
  });

  it("agent replies and notes never carry snapshots", async () => {
    await setProductDiagnostics({ ctx, productId, enabled: true });
    const sent = await sendMessageWithDiagnostics(snapshotPayload());
    if (!sent.ok) throw new Error(sent.error);
    await addAgentMessage({ ctx, conversationId: sent.conversationId, body: "On it" });
    const messages = await db.prisma.message.findMany({ orderBy: { createdAt: "asc" } });
    expect(messages).toHaveLength(2);
    const snapshotMessageIds = (
      await db.prisma.diagnosticSnapshot.findMany({ select: { messageId: true } })
    ).map((row) => row.messageId);
    expect(snapshotMessageIds).toEqual([messages[0].id]);
  });
});
