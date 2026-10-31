import { PRIVATE_NO_STORE, apiError } from "@/lib/api-errors";
import { NOT_FOUND_MESSAGE, v1Route } from "@/lib/api/v1-route";
import { addAgentMessage } from "@/lib/conversations";
import { messageBody, serializeMessage, type DeliveryState } from "@/lib/conversation-api";
import { deliverAgentReplyIfRouted } from "@/lib/email/routing";
import { parseBody } from "@/lib/product-api";
import { SERVICE_PAUSED_CODE } from "@/lib/service-pause";
import { NotInScopeError } from "@/lib/workspace-scope";

export const dynamic = "force-dynamic";

/**
 * Send a reply or add an internal note (FR-API-04..07). A reply takes the
 * dashboard's own path: same service function, same routing (chat or email),
 * same Free-plan pause, same reopen of a Closed Conversation. Replies need an
 * Idempotency-Key because they email a customer.
 */
export const POST = v1Route<{ conversationId: string }>(
  {
    operationId: "createMessage",
    scope: ["conversations:reply", "conversations:write"],
    bucket: "apiTokenReply",
    idempotent: true,
  },
  async ({ request, scope, db, params, auditResource, idempotencyKey, requireScope }) => {
    const parsed = await parseBody(request, messageBody);
    if (!parsed.ok) return parsed.response;
    const { kind, body, savedReplyId, attachmentIds } = parsed.body;

    const denied = requireScope(kind === "reply" ? "conversations:reply" : "conversations:write");
    if (denied) return denied;
    if (kind === "reply" && idempotencyKey === null) {
      return apiError("invalid_request", "Sending a reply needs an Idempotency-Key header, so a retry cannot email the customer twice.");
    }

    const conversation = await db.conversation.findUniqueOrThrow({
      where: { id: params.conversationId },
      select: { id: true, product: { select: { archivedAt: true } } },
    });
    if (kind === "reply" && conversation.product.archivedAt) {
      return apiError("conflict", "This Conversation's Product is archived, so a reply would bounce. Unarchive the Product to reply; notes still work.");
    }
    if (savedReplyId) await db.savedReply.findUniqueOrThrow({ where: { id: savedReplyId }, select: { id: true } });
    const wanted = [...new Set(attachmentIds ?? [])];
    if (wanted.length > 0) {
      const usable = await db.attachment.count({
        where: { id: { in: wanted }, messageId: null, OR: [{ conversationId: conversation.id }, { conversationId: null }] },
      });
      if (usable !== wanted.length) throw new NotInScopeError("Attachment");
    }

    const added = await addAgentMessage({
      ctx: { workspace: { id: scope.workspaceId }, token: { id: scope.tokenId } },
      conversationId: conversation.id,
      body,
      kind: kind === "reply" ? "AGENT" : "NOTE",
      attachmentIds: wanted,
    });
    if (!added.ok) {
      return added.error === "Conversation not found."
        ? apiError("not_found", NOT_FOUND_MESSAGE)
        : added.error.startsWith("Message body")
          ? apiError("invalid_request", added.error)
          : apiError(SERVICE_PAUSED_CODE, added.error);
    }
    auditResource("message", added.messageId);

    const delivery = kind === "reply" ? await deliver(scope.workspaceId, conversation.id, added.messageId) : "not_applicable";
    const message = await db.message.findUniqueOrThrow({
      where: { id: added.messageId },
      include: {
        author: { select: { id: true, name: true } },
        authorToken: { select: { id: true, name: true } },
        attachments: { select: { id: true, filename: true, contentType: true, size: true } },
      },
    });
    return Response.json(serializeMessage(message, delivery), {
      status: 201,
      headers: { ...PRIVATE_NO_STORE, location: `/api/v1/conversations/${conversation.id}/messages` },
    });
  },
);

/** The message is stored by now, so a delivery fault is reported on it, not as a failed request a client would retry. */
async function deliver(workspaceId: string, conversationId: string, messageId: string): Promise<DeliveryState> {
  try {
    const result = await deliverAgentReplyIfRouted({ workspaceId, conversationId, messageId });
    if (result.routed === "chat-only") return "not_applicable";
    return result.sent ? "sent" : "failed";
  } catch (error) {
    console.error(`[api] reply delivery crashed (message ${messageId}):`, error);
    return "failed";
  }
}
