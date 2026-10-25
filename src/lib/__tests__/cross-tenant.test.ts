import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestDb, stopTestDb, type TestDb } from "@/test/integration-db";
import { prisma } from "@/lib/prisma";
import {
  addAgentMessage,
  addCustomerMessage,
  createConversation,
  upsertContact,
} from "@/lib/conversations";
import { storeAttachment, validateAttachment } from "@/lib/attachments";
import { setAttachmentStorageForTest, type AttachmentStorage } from "@/lib/attachment-storage";

/**
 * Cross-tenant sanity matrix (docs/FRD.md, FR-SEC-01): two fully separate customers
 * (Workspace Alpha with two Products, Workspace Beta with one) attempt to
 * reach each other's data through URLs, APIs, keys and file IDs. Every
 * attempt must fail.
 */
let db: TestDb;

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

const alphaAdmin = { id: "u_alpha", name: "Alpha Admin", email: "admin@alpha.dev" };
const betaAgent = { id: "u_beta", name: "Beta Agent", email: "agent@beta.dev" };

function png(bytes = 32): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return data;
}

async function seed() {
  await prisma.user.create({ data: { ...alphaAdmin, emailVerified: false } });
  await prisma.user.create({ data: { ...betaAgent, emailVerified: false } });
  const alpha = await prisma.workspace.create({
    data: { name: "Alpha", memberships: { create: { userId: alphaAdmin.id, role: "ADMIN" } } },
  });
  const beta = await prisma.workspace.create({
    data: { name: "Beta", memberships: { create: { userId: betaAgent.id, role: "AGENT" } } },
  });
  const alphaProduct = await prisma.product.create({
    data: {
      workspaceId: alpha.id,
      name: "Alpha SaaS",
      widgetPublicKey: "pk_alpha_key",
      domains: { create: { domain: "app.alpha.dev" } },
    },
  });
  const betaProduct = await prisma.product.create({
    data: {
      workspaceId: beta.id,
      name: "Beta Tool",
      widgetPublicKey: "pk_beta_key",
      domains: { create: { domain: "app.beta.dev" } },
    },
  });
  const alphaContact = await upsertContact({ workspaceId: alpha.id, email: "sam@alpha.dev" });
  const alphaConversation = await createConversation({
    workspaceId: alpha.id,
    productId: alphaProduct.id,
    contactId: alphaContact.id,
    channel: "CHAT",
  });
  if (!alphaConversation.ok) throw new Error("seed failed");
  await addCustomerMessage({
    workspaceId: alpha.id,
    conversationId: alphaConversation.conversationId,
    body: "Alpha secret: launch-code-ALPHA-77",
    source: { kind: "visitor", visitorId: "v-alpha" },
  });
  const alphaAttachment = await storeAttachment({
    workspaceId: alpha.id,
    productId: alphaProduct.id,
    conversationId: alphaConversation.conversationId,
    visitorId: "v-alpha",
    file: validateAttachment({ name: "alpha-secret.png", type: "image/png", data: png() }),
  });

  const betaContact = await upsertContact({ workspaceId: beta.id, email: "kim@beta.dev" });
  const betaConversation = await createConversation({
    workspaceId: beta.id,
    productId: betaProduct.id,
    contactId: betaContact.id,
    channel: "EMAIL",
  });
  if (!betaConversation.ok) throw new Error("seed failed");

  return {
    alpha,
    beta,
    alphaProduct,
    betaProduct,
    alphaConversationId: alphaConversation.conversationId,
    betaConversationId: betaConversation.conversationId,
    alphaAttachmentId: alphaAttachment.id,
  };
}

beforeAll(async () => {
  db = await startTestDb();
  setAttachmentStorageForTest(new MemoryStorage());
});

afterAll(async () => {
  setAttachmentStorageForTest(null);
  await stopTestDb(db);
});

beforeEach(async () => {
  await prisma.emailDelivery.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.chatVisitor.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationTag.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.savedReply.deleteMany();
  await prisma.productDomain.deleteMany();
  await prisma.product.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
});

describe("cross-tenant matrix (docs/FRD.md, FR-SEC-01)", () => {
  it("service-level: no cross-workspace read/write path leaks", async () => {
    const s = await seed();
    const betaCtx = {
      user: betaAgent,
      workspace: { id: s.beta.id, name: "Beta" },
      role: "AGENT" as const,
    };

    // Beta agent cannot read or mutate Alpha's conversation by ID.
    const { getConversationDetail, setConversationStatus } = await import("@/lib/conversations");
    expect(await getConversationDetail({ workspaceId: s.beta.id, conversationId: s.alphaConversationId })).toBeNull();
    expect(
      (await setConversationStatus({ ctx: betaCtx, conversationId: s.alphaConversationId, status: "CLOSED" })).ok,
    ).toBe(false);
    expect(
      (await addAgentMessage({ ctx: betaCtx, conversationId: s.alphaConversationId, body: "hi" })).ok,
    ).toBe(false);

    // Beta cannot create a conversation on an Alpha product.
    const { createConversation: create } = await import("@/lib/conversations");
    const betaContact2 = await upsertContact({ workspaceId: s.beta.id, email: null });
    expect(
      (await create({ workspaceId: s.beta.id, productId: s.alphaProduct.id, contactId: betaContact2.id, channel: "CHAT" })).ok,
    ).toBe(false);

    // Search never crosses: Beta's list is empty of Alpha content.
    const { listConversations } = await import("@/lib/conversations");
    const betaList = await listConversations({ workspaceId: s.beta.id, status: "ALL", search: "ALPHA-77" });
    expect(betaList.items.length).toBe(0);

    // Attachment access control: Beta agent (no membership in Alpha) denied.
    const { getAttachmentForDownload } = await import("@/lib/attachments");
    expect((await getAttachmentForDownload({ attachmentId: s.alphaAttachmentId, workspaceId: s.beta.id })).ok).toBe(false);
    expect(
      (await getAttachmentForDownload({ attachmentId: s.alphaAttachmentId, visitorId: "v-beta" })).ok,
    ).toBe(false);
    expect(
      (await getAttachmentForDownload({ attachmentId: s.alphaAttachmentId, visitorId: "v-alpha" })).ok,
    ).toBe(true);

    // Widget key from one product cannot drive another product's session.
    const { createVisitorSession, resolveVisitorSession, loadWidgetProduct } = await import("@/lib/widget");
    const alphaProductByKey = (await loadWidgetProduct("pk_alpha_key"))!;
    const { token: alphaToken } = await createVisitorSession(alphaProductByKey, "app.alpha.dev");
    const betaProductByKey = (await loadWidgetProduct("pk_beta_key"))!;
    expect(await resolveVisitorSession(betaProductByKey, alphaToken)).toBeNull();
  });

  it("route-level: attachment ids are unguessable-scoped (visitor access matrix)", async () => {
    // Covered above at the service level; here assert the visitor binding
    // used by the download route's visitor path.
    const s = await seed();
    const betaVisitor = await prisma.chatVisitor.create({
      data: {
        productId: s.betaProduct.id,
        tokenHash: "hash_cross_beta",
        conversationId: s.betaConversationId,
        origin: "app.beta.dev",
      },
    });
    const { getAttachmentForDownload } = await import("@/lib/attachments");
    // Beta's visitor cannot fetch Alpha's attachment even with the id.
    expect(
      (await getAttachmentForDownload({ attachmentId: s.alphaAttachmentId, visitorId: betaVisitor.id })).ok,
    ).toBe(false);
  });

  it("session binding: a visitor cookie cannot be replayed from another origin", async () => {
    const s = await seed();
    const { createVisitorSession, sessionOriginMatches, loadWidgetProduct } = await import("@/lib/widget");
    const product = (await loadWidgetProduct("pk_alpha_key"))!;
    const { session } = await createVisitorSession(product, "app.alpha.dev");

    expect(sessionOriginMatches(session, "https://app.alpha.dev/pricing")).toBe(true);
    expect(sessionOriginMatches(session, "https://evil.example.com")).toBe(false);
    expect(sessionOriginMatches(session, null)).toBe(false);

    // Same key but the Beta product domain: also rejected for this session.
    expect(sessionOriginMatches(session, "https://app.beta.dev")).toBe(false);
    void s;
  });
});
