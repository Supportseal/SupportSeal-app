import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";
import type { TENANT_MODELS } from "@/lib/workspace-scope";

export type TenantModel = {
  [M in keyof typeof TENANT_MODELS]: (typeof TENANT_MODELS)[M]["kind"] extends "global" ? never : M;
}[keyof typeof TENANT_MODELS];

/**
 * One row of every tenant model in a fresh Workspace, keyed by model with each
 * row's unique `where`. Every row's text carries `canary`, so a response that
 * leaks any of them contains it.
 */
export type TenantRows = {
  workspaceId: string;
  userId: string;
  canary: string;
  where: Record<TenantModel, Record<string, unknown>>;
};

export async function seedTenant(prisma: PrismaClient, label: string): Promise<TenantRows> {
  const tag = `${label}-${randomUUID().slice(0, 8)}`;
  const workspace = await prisma.workspace.create({ data: { name: `Workspace ${tag}` } });
  const workspaceId = workspace.id;
  const user = await prisma.user.create({
    data: { id: `user_${tag}`, name: tag, email: `${tag}@example.test`, emailVerified: true },
  });
  const membership = await prisma.membership.create({ data: { userId: user.id, workspaceId, role: "ADMIN" } });
  const invite = await prisma.invite.create({
    data: {
      workspaceId,
      email: `invitee-${tag}@example.test`,
      role: "AGENT",
      tokenHash: `invite-${tag}`,
      invitedById: user.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const product = await prisma.product.create({
    data: { workspaceId, name: `Product ${tag}`, widgetPublicKey: `pk_${tag}` },
  });
  const productId = product.id;
  const contact = await prisma.contact.create({ data: { workspaceId, email: `customer-${tag}@example.test` } });
  const conversation = await prisma.conversation.create({
    data: { workspaceId, ticketNumber: 1, productId, contactId: contact.id, channel: "CHAT" },
  });
  const conversationId = conversation.id;
  const message = await prisma.message.create({
    data: { conversationId, kind: "CUSTOMER", body: `canary ${tag}` },
  });
  const visitor = await prisma.chatVisitor.create({ data: { productId, tokenHash: `visitor-${tag}`, conversationId } });
  const signal = await prisma.widgetHostSignal.create({
    data: { productId, host: `${tag}.example.test`, outcome: "LOADED", lastSeenAt: new Date() },
  });
  const domain = await prisma.productDomain.create({ data: { productId, domain: `${tag}.example.test` } });
  const mailDomain = await prisma.productMailDomain.create({
    data: { productId, domain: `mail.${tag}.example.test`, verificationToken: `verify-${tag}` },
  });
  const snapshot = await prisma.diagnosticSnapshot.create({
    data: {
      workspaceId,
      productId,
      conversationId,
      messageId: message.id,
      schemaVersion: 1,
      environment: {},
      events: [],
      errorCount: 0,
      warningCount: 0,
      networkFailureCount: 0,
      droppedCount: 0,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const tagRow = await prisma.tag.create({ data: { workspaceId, name: `tag-${tag}` } });
  const conversationTag = await prisma.conversationTag.create({ data: { conversationId, tagId: tagRow.id } });
  const attachment = await prisma.attachment.create({
    data: {
      workspaceId,
      productId,
      conversationId,
      messageId: message.id,
      filename: "canary.txt",
      contentType: "text/plain",
      size: 6,
      storageKey: `key-${tag}`,
    },
  });
  const delivery = await prisma.emailDelivery.create({
    data: { workspaceId, productId, conversationId, direction: "INBOUND", status: "RECEIVED" },
  });
  const savedReply = await prisma.savedReply.create({
    data: { workspaceId, name: `reply-${tag}`, body: `canary ${tag}`, createdById: user.id },
  });
  await prisma.savedReplyProduct.create({ data: { savedReplyId: savedReply.id, productId } });
  const notification = await prisma.usageNotification.create({
    data: { workspaceId, period: "2026-10", level: "APPROACHING" },
  });
  const token = await prisma.apiToken.create({
    data: { workspaceId, name: `token-${tag}`, tokenHash: `hash-${tag}`, lastFour: "abcd", createdById: user.id },
  });
  await prisma.messageReadReceipt.create({ data: { membershipId: membership.id, messageId: message.id } });

  const where: TenantRows["where"] = {
    Workspace: { id: workspaceId },
    Membership: { id: membership.id },
    Invite: { id: invite.id },
    Product: { id: productId },
    Contact: { id: contact.id },
    Conversation: { id: conversationId },
    DiagnosticSnapshot: { id: snapshot.id },
    Tag: { id: tagRow.id },
    Attachment: { id: attachment.id },
    EmailDelivery: { id: delivery.id },
    SavedReply: { id: savedReply.id },
    UsageNotification: { id: notification.id },
    ApiToken: { id: token.id },
    ChatVisitor: { id: visitor.id },
    WidgetHostSignal: { id: signal.id },
    ProductDomain: { id: domain.id },
    ProductMailDomain: { id: mailDomain.id },
    Message: { id: message.id },
    ConversationTag: { id: conversationTag.id },
    MessageReadReceipt: { membershipId_messageId: { membershipId: membership.id, messageId: message.id } },
    SavedReplyProduct: { savedReplyId_productId: { savedReplyId: savedReply.id, productId } },
  };
  return { workspaceId, userId: user.id, canary: tag, where };
}
