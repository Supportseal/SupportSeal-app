import { PRIVATE_NO_STORE, apiError } from "@/lib/api-errors";
import { NOT_FOUND_MESSAGE, v1Route } from "@/lib/api/v1-route";
import { conversationPatchBody, serializeConversation } from "@/lib/conversation-api";
import { updateConversation } from "@/lib/conversations";
import { parseBody } from "@/lib/product-api";

export const dynamic = "force-dynamic";

/**
 * Close, reopen or tag a Conversation (FR-API-04). Status and tag changes
 * apply together or not at all; a body that changes nothing is a 400.
 */
export const PATCH = v1Route<{ conversationId: string }>(
  { operationId: "updateConversation", scope: "conversations:write", idempotent: true },
  async ({ request, scope, db, params, auditResource }) => {
    const parsed = await parseBody(request, conversationPatchBody);
    if (!parsed.ok) return parsed.response;

    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: params.conversationId }, select: { id: true } });
    auditResource("conversation", conversation.id);
    const result = await updateConversation({ workspaceId: scope.workspaceId, conversationId: conversation.id, changes: parsed.body });
    if (!result.ok) {
      return result.error === "Conversation not found."
        ? apiError("not_found", NOT_FOUND_MESSAGE)
        : apiError("invalid_request", result.error);
    }
    const updated = await db.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
      select: {
        id: true,
        ticketNumber: true,
        productId: true,
        contactId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        tags: { select: { tag: { select: { name: true } } } },
      },
    });
    return Response.json(serializeConversation(updated), { headers: PRIVATE_NO_STORE });
  },
);
