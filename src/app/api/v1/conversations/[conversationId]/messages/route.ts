import { signCursor, verifyCursor, type CursorBinding } from "@/lib/api/cursor";
import { PRIVATE_NO_STORE, apiError } from "@/lib/api-errors";
import { invalidCursor, MAX_CURSOR_LENGTH, parseQuery } from "@/lib/api/query";
import { NOT_FOUND_MESSAGE, v1Route } from "@/lib/api/v1-route";
import { ATTACHMENT_UNAVAILABLE_MESSAGE, addAgentMessage } from "@/lib/conversations";
import { messageBody, messageListQuery, serializeMessage, type DeliveryState } from "@/lib/conversation-api";
import { deliverAgentReplyIfRouted } from "@/lib/email/routing";
import { parseBody } from "@/lib/product-api";
import { SERVICE_PAUSED_CODE } from "@/lib/service-pause";
import { NotInScopeError } from "@/lib/workspace-scope";

export const dynamic = "force-dynamic";

const ROUTE = "/api/v1/conversations/{conversationId}/messages";

/**
 * The Conversation's Messages, oldest first — the thread an agent works
 * (FR-API-08). The list's pagination contract, bound to this Workspace, this
 * route and this Conversation; each reply carries its delivery state from the
 * email ledger.
 */
export const GET = v1Route<{ conversationId: string }>(
  { operationId: "listMessages", scope: "conversations:read" },
  async ({ request, scope, db, params }) => {
    const parsed = parseQuery(new URL(request.url).searchParams, messageListQuery);
    if (!parsed.ok) return parsed.response;
    const { limit, cursor } = parsed.query;

    // Prove the parent Conversation exists in this Workspace first: a Message
    // query alone would answer a foreign id with an empty list, not the 404.
    const conversation = await db.conversation.findUniqueOrThrow({
      where: { id: params.conversationId },
      select: { id: true },
    });
    const binding: CursorBinding = { workspaceId: scope.workspaceId, route: ROUTE, pathIds: [conversation.id] };

    let position: { id: string; createdAt: Date } | null = null;
    if (cursor !== undefined) {
      if (cursor.length > MAX_CURSOR_LENGTH) return invalidCursor();
      const payload = verifyCursor(binding, cursor);
      const id = typeof payload?.id === "string" ? payload.id : null;
      const when = typeof payload?.createdAt === "string" ? new Date(payload.createdAt) : null;
      if (id === null || when === null || Number.isNaN(when.getTime())) return invalidCursor();
      position = { id, createdAt: when };
    }

    const rows = await db.message.findMany({
      where: {
        conversationId: conversation.id,
        // The cursor carries only the sort keys (createdAt, id) of a row the
        // caller already saw, so a page resumes even if that row was deleted.
        ...(position
          ? { OR: [{ createdAt: { gt: position.createdAt } }, { AND: [{ createdAt: position.createdAt }, { id: { gt: position.id } }] }] }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        conversationId: true,
        kind: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, name: true } },
        authorToken: { select: { id: true, name: true } },
        attachments: { select: { id: true, filename: true, contentType: true, size: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    // One scoped ledger query per page, not per row: an emailed reply reads
    // `sent` or `failed`, a chat-only reply (no row), a note or a customer
    // message reads `not_applicable` — the states the create response uses.
    const replies = page.filter((row) => row.kind === "AGENT").map((row) => row.id);
    const ledger =
      replies.length > 0
        ? await db.emailDelivery.findMany({ where: { agentMessageId: { in: replies } }, select: { agentMessageId: true, status: true } })
        : [];
    const states = new Map(
      ledger.flatMap((row): [string, DeliveryState][] => {
        if (row.agentMessageId === null) return [];
        // An agentMessageId row is outbound: SENT reached the customer, FAILED
        // did not; the inbound statuses cannot appear on one.
        return [[row.agentMessageId, row.status === "SENT" ? "sent" : row.status === "FAILED" ? "failed" : "not_applicable"]];
      }),
    );

    return Response.json(
      {
        items: page.map((row) => serializeMessage(row, states.get(row.id) ?? "not_applicable")),
        nextCursor: hasMore && last ? signCursor(binding, { id: last.id, createdAt: last.createdAt.toISOString() }) : null,
      },
      { headers: PRIVATE_NO_STORE },
    );
  },
);

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
      if (added.error === "Conversation not found.") return apiError("not_found", NOT_FOUND_MESSAGE);
      // Claimed between the pre-check and the send: indistinguishable from an unknown id.
      if (added.error === ATTACHMENT_UNAVAILABLE_MESSAGE) throw new NotInScopeError("Attachment");
      return added.error.startsWith("Message body")
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
