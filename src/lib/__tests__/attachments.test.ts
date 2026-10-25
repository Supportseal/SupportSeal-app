import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import {
  getAttachmentStorage,
  setAttachmentStorageForTest,
  type AttachmentStorage,
} from "@/lib/attachment-storage";
import {
  AttachmentError,
  formatFileSize,
  getAttachmentForDownload,
  linkAttachmentToMessage,
  sanitizeFilename,
  storeAttachment,
  validateAttachment,
} from "@/lib/attachments";
import { createTestUser } from "@/test/integration-db";
import { type WorkspaceContext } from "@/lib/workspace";
import { createProduct } from "@/lib/products";
import { addCustomerMessage, createConversation, upsertContact } from "@/lib/conversations";

let db: TestDb;
let ctx: WorkspaceContext;
let productId: string;

/** Deterministic in-memory storage for tests. */
class MemoryStorage implements AttachmentStorage {
  files = new Map<string, Uint8Array>();
  async put(data: Uint8Array) {
    const key = `mem${this.files.size + 1}`;
    this.files.set(key, data);
    return key;
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

const memoryStorage = new MemoryStorage();

function png(bytes = 64): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return data;
}

beforeAll(async () => {
  db = await startTestDb();
  setAttachmentStorageForTest(memoryStorage);
});

afterAll(async () => {
  await stopTestDb(db);
});

beforeEach(async () => {
  memoryStorage.files.clear();
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

  const user = await createTestUser(db.prisma, { email: "founder@example.com" });
  const ws = await db.prisma.workspace.create({
    data: { name: "Acme", memberships: { create: { userId: user.id, role: "ADMIN" } } },
  });
  ctx = { user, workspace: { id: ws.id, name: "Acme" }, role: "ADMIN" };
  const product = await createProduct({ ctx, name: "Alpha" });
  if (!product.ok) throw new Error(product.error);
  productId = product.product.id;
});

describe("validateAttachment (FR-FILE-01)", () => {
  it("accepts real images regardless of declared type", () => {
    const result = validateAttachment({ name: "photo.PNG", type: "", data: png() });
    expect(result.contentType).toBe("image/png");
    expect(result.filename).toBe("photo.PNG");
  });

  it("rejects mismatched content (extension alone is not trusted)", () => {
    const fakePng = new Uint8Array(100);
    fakePng.set([0x4d, 0x5a]); // PE magic
    expect(() => validateAttachment({ name: "evil.png", type: "image/png", data: fakePng })).toThrow(
      AttachmentError,
    );
  });

  it("accepts text types when declared type and extension agree", () => {
    const text = new TextEncoder().encode("hello,world");
    const result = validateAttachment({ name: "data.csv", type: "text/csv", data: text });
    expect(result.contentType).toBe("text/csv");
  });

  it("rejects unsupported types and oversize files", () => {
    expect(() =>
      validateAttachment({ name: "app.exe", type: "application/octet-stream", data: png() }),
    ).toThrow(AttachmentError);
    const big = png(10 * 1024 * 1024 + 1);
    expect(() => validateAttachment({ name: "big.png", type: "image/png", data: big })).toThrow(
      AttachmentError,
    );
  });

  it("sanitizes display filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a<b>c\u0000:d.txt")).toBe("a_b_c_d.txt");
    expect(sanitizeFilename("")).toBe("file");
  });
});

describe("storage and access control", () => {
  it("stores, links to messages and downloads only for authorised callers", async () => {
    const stored = await storeAttachment({
      workspaceId: ctx.workspace.id,
      productId,
      visitorId: "visitor-1",
      file: validateAttachment({ name: "shot.png", type: "image/png", data: png() }),
    });
    expect(memoryStorage.files.size).toBe(1);

    // wrong workspace: denied; owning visitor: allowed
    expect((await getAttachmentForDownload({ attachmentId: stored.id, workspaceId: "other" })).ok).toBe(false);
    const visitorAccess = await getAttachmentForDownload({ attachmentId: stored.id, visitorId: "visitor-1" });
    expect(visitorAccess.ok).toBe(true);
    // agent of the workspace: allowed
    expect((await getAttachmentForDownload({ attachmentId: stored.id, workspaceId: ctx.workspace.id })).ok).toBe(true);
    // anonymous: denied
    expect((await getAttachmentForDownload({ attachmentId: stored.id })).ok).toBe(false);

    // link to a message; download data round-trips
    const contact = await upsertContact({ workspaceId: ctx.workspace.id, email: null });
    const conversation = await createConversation({
      workspaceId: ctx.workspace.id,
      productId,
      contactId: contact.id,
      channel: "CHAT",
    });
    if (!conversation.ok) throw new Error(conversation.error);
    const message = await addCustomerMessage({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.conversationId,
      body: "see attached",
      source: { kind: "visitor", visitorId: "visitor-1" },
      attachmentIds: [stored.id],
    });
    expect(message.ok).toBe(true);

    const linked = await db.prisma.attachment.findUnique({ where: { id: stored.id } });
    expect(linked?.messageId).not.toBeNull();
    expect(linked?.conversationId).toBe(conversation.conversationId);

    const data = await getAttachmentStorage().get((visitorAccess as { storageKey: string }).storageKey);
    expect(data[0]).toBe(0x89);
  });

  it("cannot link attachments from another workspace or another conversation", async () => {
    const foreign = await storeAttachment({
      workspaceId: ctx.workspace.id,
      productId,
      file: validateAttachment({ name: "a.png", type: "image/png", data: png() }),
    });
    const contact = await upsertContact({ workspaceId: ctx.workspace.id, email: null });
    const conversation = await createConversation({
      workspaceId: ctx.workspace.id,
      productId,
      contactId: contact.id,
      channel: "CHAT",
    });
    if (!conversation.ok) throw new Error(conversation.error);
    const message = await addCustomerMessage({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.conversationId,
      body: "x",
      source: { kind: "visitor", visitorId: "v" },
    });
    if (!message.ok) throw new Error(message.error);
    const messageId = (await db.prisma.message.findFirstOrThrow({ where: { conversationId: conversation.conversationId } })).id;

    const linked = await linkAttachmentToMessage({
      workspaceId: "not-this-workspace",
      attachmentIds: [foreign.id],
      conversationId: conversation.conversationId,
      messageId,
    });
    expect(linked).toBe(0);
  });

  it("formats sizes for display", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
