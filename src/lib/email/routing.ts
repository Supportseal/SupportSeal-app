import { prisma } from "@/lib/prisma";
import { sendReplyEmail, replySubject } from "@/lib/email/outbound";
import { notifyConversationEvent } from "@/lib/events";
import { isOwnAddress } from "@/lib/email/loop-guard";

/**
 * Reply-channel routing (design default D5, FR-EMAIL-02):
 * - email-started conversation → email
 * - chat conversation with a known visitor email and the visitor no longer
 *   connected (no heartbeat within 60 s) → email as well, stored in the
 *   chat thread so the visitor sees it if they return
 * - chat conversation, visitor connected or no email → chat only
 */
export const VISITOR_CONNECTED_WINDOW_MS = 60_000;

export type RoutingDecision = "email" | "chat-only";

export async function decideReplyRouting(input: {
  channel: "CHAT" | "EMAIL";
  visitorEmail: string | null;
  visitorLastSeenAt: Date | null;
}): Promise<RoutingDecision> {
  if (input.channel === "EMAIL") return "email";
  if (!input.visitorEmail) return "chat-only";
  if (!input.visitorLastSeenAt) return "email";
  return Date.now() - input.visitorLastSeenAt.getTime() > VISITOR_CONNECTED_WINDOW_MS
    ? "email"
    : "chat-only";
}

/**
 * Deliver an agent reply by email when the routing decision says so. Called
 * after the message is durably stored; failures are recorded on the delivery
 * row (visible for follow-up) and never block the chat thread.
 */
export async function deliverAgentReplyIfRouted(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}): Promise<{ routed: RoutingDecision; sent: boolean; error?: string }> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId },
    include: {
      product: { select: { id: true, name: true, supportEmail: true, inboundEmail: true } },
      contact: { select: { email: true } },
      chatVisitors: { orderBy: { lastSeenAt: "desc" }, take: 1, select: { email: true, lastSeenAt: true } },
    },
  });
  if (!conversation) return { routed: "chat-only", sent: false, error: "conversation not found" };

  const visitor = conversation.chatVisitors[0] ?? null;
  // A visitor/contact address that is the Product's own support or
  // forwarding address would loop straight back in (loop-guard.ts). For
  // chat routing treat it as "no email known", so the reply stays in the
  // chat thread. An email-started conversation still routes by email, and
  // sendReplyEmail then refuses the send and records a FAILED delivery, so
  // the undelivered reply stays visible instead of silently vanishing.
  const knownEmail = visitor?.email ?? conversation.contact.email;
  const decision = await decideReplyRouting({
    channel: conversation.channel,
    visitorEmail: isOwnAddress(knownEmail, conversation.product) ? null : knownEmail,
    visitorLastSeenAt: visitor?.lastSeenAt ?? null,
  });

  // Persist the actual channel decision (issue #128): the agent Message was
  // stored channel-less because this decision is what defines its channel.
  // Compare-and-set on channel: NULL so repeat deliveries never flip a
  // channel an earlier decision already committed (the transient icon shows
  // nothing rather than a wrong channel), and the tenant/kind guards make
  // the writer refuse anything but this conversation's pending AGENT reply
  // — a NOTE or customer Message passed by accident is never annotated. A
  // send failure after an "email" decision keeps EMAIL — the reply was
  // routed by mail; the delivery ledger already surfaces the failure.
  const channelChanged = await prisma.$transaction(async (tx) => {
    const updated = await tx.message.updateMany({
      where: {
        id: input.messageId,
        conversationId: conversation.id,
        kind: "AGENT",
        channel: null,
      },
      data: { channel: decision === "email" ? "EMAIL" : "CHAT" },
    });
    if (updated.count === 0) return false;
    // The durable signature wakes inbox streams in other app processes.
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });
    return true;
  });
  if (channelChanged) {
    notifyConversationEvent({
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      kind: "context",
    });
  }

  if (decision === "chat-only") return { routed: decision, sent: false };

  const to = knownEmail;
  if (!to) return { routed: "chat-only", sent: false, error: "no email address" };

  const message = await prisma.message.findUnique({
    where: { id: input.messageId },
    select: {
      body: true,
      attachments: { select: { id: true, filename: true, contentType: true, storageKey: true } },
    },
  });
  if (!message) return { routed: decision, sent: false, error: "message not found" };

  // Resolve (and persist) the reply token BEFORE building the message so
  // first-time emails carry the Reply-To header. Compare-and-set so two
  // concurrent sends cannot persist different tokens.
  let replyToken = conversation.emailReplyToken;
  if (!replyToken) {
    const candidate = crypto.randomUUID().replace(/-/gu, "").toLowerCase();
    const updated = await prisma.conversation.updateMany({
      where: { id: conversation.id, emailReplyToken: null },
      data: { emailReplyToken: candidate },
    });
    replyToken =
      updated.count > 0
        ? candidate
        : (await prisma.conversation.findUniqueOrThrow({
            where: { id: conversation.id },
            select: { emailReplyToken: true },
          })).emailReplyToken ?? candidate;
  }

  // Attachment-only replies must reach the customer with their files.
  const { getAttachmentStorage } = await import("@/lib/attachment-storage");
  const mailAttachments: Array<{ filename: string; contentType: string; content: Buffer }> = [];
  let missingAttachments = 0;
  for (const attachment of message.attachments.slice(0, 10)) {
    try {
      const data = await getAttachmentStorage().get(attachment.storageKey);
      mailAttachments.push({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: Buffer.from(data),
      });
    } catch {
      missingAttachments += 1; // storage miss: text goes out, note it
    }
  }

  // Latest inbound Message-ID = the immediate parent customers reply to.
  const latestInboundDelivery = await prisma.emailDelivery.findFirst({
    where: { conversationId: conversation.id, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { providerMessageId: true },
  });
  const latestInboundId = latestInboundDelivery?.providerMessageId ?? null;
  const lastOutbound = await prisma.emailDelivery.findFirst({
    where: { conversationId: conversation.id, direction: "OUTBOUND", status: "SENT" },
    orderBy: { createdAt: "desc" },
    select: { providerMessageId: true },
  });

  const result = await sendReplyEmail({
    workspaceId: input.workspaceId,
    productId: conversation.product.id,
    conversationId: conversation.id,
    agentMessageId: input.messageId,
    note: missingAttachments > 0 ? `${missingAttachments} attachment(s) missing from storage` : undefined,
    message: {
      to,
      subject: replySubject(conversation.subject, conversation.product.name, conversation.ticketNumber),
      text: message.body,
      replyToken,
      attachments: mailAttachments,
      productName: conversation.product.name,
      // Thread on the latest inbound Message-ID (immediate parent) with the
      // root + latest outbound in References.
      inReplyToHeader: latestInboundId ?? conversation.emailMessageId ?? null,
      referencesHeader:
        [conversation.emailMessageId, latestInboundId, lastOutbound?.providerMessageId]
          .filter((id): id is string => Boolean(id))
          .join(" ") || null,
    },
  });

  return { routed: decision, sent: result.ok, error: result.ok ? undefined : result.error };
}
