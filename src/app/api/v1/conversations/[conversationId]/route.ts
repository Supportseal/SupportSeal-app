import { PRIVATE_NO_STORE, apiError } from "@/lib/api-errors";
import { NOT_FOUND_MESSAGE, v1Route } from "@/lib/api/v1-route";
import { conversationPatchBody, conversationSelect, serializeConversation } from "@/lib/conversation-api";
import { deleteConversation, updateConversation } from "@/lib/conversations";
import { parseBody } from "@/lib/product-api";

export const dynamic = "force-dynamic";

/**
 * One Conversation of this Workspace (FR-API-08): the same shape the list
 * returns, for when an agent already knows the id. An unknown or foreign id
 * is the uniform 404.
 */
export const GET = v1Route<{ conversationId: string }>(
  { operationId: "getConversation", scope: "conversations:read" },
  async ({ db, params }) => {
    const conversation = await db.conversation.findUniqueOrThrow({
      where: { id: params.conversationId },
      select: conversationSelect,
    });
    return Response.json(serializeConversation(conversation), { headers: PRIVATE_NO_STORE });
  },
);

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
      select: conversationSelect,
    });
    return Response.json(serializeConversation(updated), { headers: PRIVATE_NO_STORE });
  },
);

/**
 * Delete a Conversation for good (FR-API-09, FR-SEC-02): messages, notes,
 * tags, diagnostics and attachments go with it, and a Contact left without
 * Conversations is deleted too. Admin-equivalent, so it has its own scope.
 * An unknown, foreign or already deleted id is the uniform 404.
 */
export const DELETE = v1Route<{ conversationId: string }>(
  { operationId: "deleteConversation", scope: "conversations:delete" },
  async ({ scope, db, params, auditResource }) => {
    const conversation = await db.conversation.findUniqueOrThrow({ where: { id: params.conversationId }, select: { id: true } });
    auditResource("conversation", conversation.id);
    const result = await deleteConversation({ workspaceId: scope.workspaceId, conversationId: conversation.id });
    if (!result.ok) return apiError("not_found", NOT_FOUND_MESSAGE);
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  },
);
