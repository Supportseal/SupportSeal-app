import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DELETE as deleteConversationRoute } from "@/app/api/v1/conversations/[conversationId]/route";
import { setAttachmentStorageForTest, type AttachmentStorage } from "@/lib/attachment-storage";
import { NOT_FOUND_MESSAGE } from "@/lib/api/v1-route";
import { deleteConversation } from "@/lib/conversations";
import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { seedTenant, type TenantRows } from "@/test/tenant-fixtures";
import { mintToken, v1Request } from "@/test/v1-harness";

class MemoryStorage implements AttachmentStorage {
  files = new Map<string, Uint8Array>();
  failOn = new Set<string>();
  async put(data: Uint8Array, key?: string) {
    const storageKey = key ?? crypto.randomUUID();
    this.files.set(storageKey, data);
    return storageKey;
  }
  async get(key: string) {
    const file = this.files.get(key);
    if (!file) throw new Error("missing");
    return file;
  }
  async delete(key: string) {
    if (this.failOn.has(key)) throw new Error("disk on fire");
    this.files.delete(key);
  }
}

let db: TestDb;
let alpha: TenantRows;
let beta: TenantRows;
let storage: MemoryStorage;
let productId: string;
let ticket = 100;

/** A Conversation with a message, a note, a tag, an attachment file and an email ledger row. */
async function seedThread(input: { contactId?: string; email?: string } = {}) {
  const contactId =
    input.contactId ??
    (await db.prisma.contact.create({ data: { workspaceId: alpha.workspaceId, email: input.email ?? null } })).id;
  ticket += 1;
  const conversation = await db.prisma.conversation.create({
    data: { workspaceId: alpha.workspaceId, ticketNumber: ticket, productId, contactId, channel: "EMAIL", subject: "Cheap pills" },
  });
  const message = await db.prisma.message.create({
    data: { conversationId: conversation.id, kind: "CUSTOMER", body: "Buy now" },
  });
  await db.prisma.message.create({ data: { conversationId: conversation.id, kind: "NOTE", body: "spam" } });
  const tag = await db.prisma.tag.upsert({
    where: { workspaceId_name: { workspaceId: alpha.workspaceId, name: "spam" } },
    create: { workspaceId: alpha.workspaceId, name: "spam" },
    update: {},
  });
  await db.prisma.conversationTag.create({ data: { conversationId: conversation.id, tagId: tag.id } });
  const storageKey = await storage.put(new Uint8Array([1, 2, 3]));
  await db.prisma.attachment.create({
    data: {
      workspaceId: alpha.workspaceId,
      productId,
      conversationId: conversation.id,
      messageId: message.id,
      filename: "offer.pdf",
      contentType: "application/pdf",
      size: 3,
      storageKey,
    },
  });
  const delivery = await db.prisma.emailDelivery.create({
    data: {
      workspaceId: alpha.workspaceId,
      productId,
      conversationId: conversation.id,
      direction: "INBOUND",
      status: "RECEIVED",
      providerMessageId: `<${conversation.id}@spam.test>`,
      messageId: message.id,
      fromAddress: "spammer@spam.test",
      toAddress: "support@acme.test",
      subject: "Cheap pills",
    },
  });
  return { conversationId: conversation.id, contactId, storageKey, deliveryId: delivery.id, tagId: tag.id };
}

const params = (id: string) => ({ params: Promise.resolve({ conversationId: id }) });
const remove = (token: string, id: string) =>
  deleteConversationRoute(v1Request("DELETE", `/api/v1/conversations/${id}`, { token }), params(id));

beforeAll(async () => {
  db = await startTestDb();
  alpha = await seedTenant(db.prisma, "alpha");
  beta = await seedTenant(db.prisma, "beta");
  productId = (await db.prisma.product.findFirstOrThrow({ where: { workspaceId: alpha.workspaceId } })).id;
});

afterAll(async () => {
  setAttachmentStorageForTest(null);
  await stopTestDb(db);
});

beforeEach(() => {
  storage = new MemoryStorage();
  setAttachmentStorageForTest(storage);
});

describe("deleteConversation", () => {
  it("removes the thread, its notes, tags and attachment files, and scrubs the email ledger", async () => {
    const thread = await seedThread({ email: "spammer@spam.test" });

    expect(await deleteConversation({ workspaceId: alpha.workspaceId, conversationId: thread.conversationId })).toEqual({ ok: true });

    expect(await db.prisma.conversation.findUnique({ where: { id: thread.conversationId } })).toBeNull();
    expect(await db.prisma.message.count({ where: { conversationId: thread.conversationId } })).toBe(0);
    expect(await db.prisma.conversationTag.count({ where: { conversationId: thread.conversationId } })).toBe(0);
    expect(await db.prisma.attachment.count({ where: { storageKey: thread.storageKey } })).toBe(0);
    expect(storage.files.has(thread.storageKey)).toBe(false);
    // The Workspace tag itself stays: other conversations may use it.
    expect(await db.prisma.tag.count({ where: { id: thread.tagId } })).toBe(1);
    // The ledger keeps only provider ids, so a retried webhook still deduplicates.
    expect(await db.prisma.emailDelivery.findUniqueOrThrow({ where: { id: thread.deliveryId } })).toMatchObject({
      conversationId: null,
      fromAddress: null,
      toAddress: null,
      subject: null,
      providerMessageId: `<${thread.conversationId}@spam.test>`,
    });
    // The Contact had nothing else, so it is gone too (FR-SEC-02).
    expect(await db.prisma.contact.findUnique({ where: { id: thread.contactId } })).toBeNull();
  });

  it("keeps a Contact who still has another Conversation", async () => {
    const first = await seedThread({ email: "regular@customer.test" });
    const second = await seedThread({ contactId: first.contactId });

    await deleteConversation({ workspaceId: alpha.workspaceId, conversationId: first.conversationId });

    expect(await db.prisma.contact.findUnique({ where: { id: first.contactId } })).not.toBeNull();
    expect(await db.prisma.conversation.findUnique({ where: { id: second.conversationId } })).not.toBeNull();
    expect(storage.files.has(second.storageKey)).toBe(true);
  });

  it("still deletes when a file cannot be removed, leaving only the orphan file", async () => {
    const thread = await seedThread();
    storage.failOn.add(thread.storageKey);

    expect(await deleteConversation({ workspaceId: alpha.workspaceId, conversationId: thread.conversationId })).toEqual({ ok: true });
    expect(await db.prisma.conversation.findUnique({ where: { id: thread.conversationId } })).toBeNull();
    expect(await db.prisma.attachment.count({ where: { storageKey: thread.storageKey } })).toBe(0);
  });

  it("never deletes another Workspace's Conversation", async () => {
    const thread = await seedThread();
    expect(await deleteConversation({ workspaceId: beta.workspaceId, conversationId: thread.conversationId })).toEqual({
      ok: false,
      error: "Conversation not found.",
    });
    expect(await db.prisma.conversation.findUnique({ where: { id: thread.conversationId } })).not.toBeNull();
    expect(storage.files.has(thread.storageKey)).toBe(true);
  });
});

describe("DELETE /api/v1/conversations/{id}", () => {
  it("answers 204 with no body, then 404 for the same id", async () => {
    const { token } = await mintToken(db.prisma, alpha.workspaceId, ["conversations:delete"]);
    const thread = await seedThread();

    const response = await remove(token, thread.conversationId);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
    expect(await db.prisma.conversation.findUnique({ where: { id: thread.conversationId } })).toBeNull();

    const again = await remove(token, thread.conversationId);
    expect(again.status).toBe(404);
    expect((await again.json()).error).toMatchObject({ code: "not_found", message: NOT_FOUND_MESSAGE });
  });

  it("needs conversations:delete; write and reply tokens cannot delete", async () => {
    const { token } = await mintToken(db.prisma, alpha.workspaceId, ["conversations:write", "conversations:reply", "contacts:read"]);
    const thread = await seedThread();

    const response = await remove(token, thread.conversationId);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("insufficient_scope");
    expect(await db.prisma.conversation.findUnique({ where: { id: thread.conversationId } })).not.toBeNull();
  });

  it("answers another Workspace's id exactly like an unknown one and deletes nothing", async () => {
    const { token } = await mintToken(db.prisma, beta.workspaceId, ["conversations:delete"]);
    const thread = await seedThread();

    const foreign = await remove(token, thread.conversationId);
    const unknown = await remove(token, crypto.randomUUID());
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await unknown.text());
    expect(await db.prisma.conversation.findUnique({ where: { id: thread.conversationId } })).not.toBeNull();
  });

  it("writes an audit row naming the deleted Conversation", async () => {
    const { token, row } = await mintToken(db.prisma, alpha.workspaceId, ["conversations:delete"]);
    const thread = await seedThread();
    await remove(token, thread.conversationId);

    const audit = await db.prisma.apiAuditLog.findFirstOrThrow({ where: { tokenId: row.id }, orderBy: { createdAt: "desc" } });
    expect(audit).toMatchObject({ operationId: "deleteConversation", resourceType: "conversation", resourceId: thread.conversationId });
  });
});
