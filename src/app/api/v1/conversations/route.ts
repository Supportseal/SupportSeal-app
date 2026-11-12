import { signCursor, verifyCursor, type CursorBinding } from "@/lib/api/cursor";
import { PRIVATE_NO_STORE } from "@/lib/api-errors";
import { invalidCursor, MAX_CURSOR_LENGTH, parseQuery } from "@/lib/api/query";
import { v1Route } from "@/lib/api/v1-route";
import { conversationListQuery, conversationSelect, serializeConversation } from "@/lib/conversation-api";
import { parseTicketSearch } from "@/lib/ticket";
import { NotInScopeError } from "@/lib/workspace-scope";

export const dynamic = "force-dynamic";

const ROUTE = "/api/v1/conversations";

/**
 * The Workspace's Conversations, oldest first (the inbox order, FR-API-08):
 * the same filters the inbox list takes, on the scoped client, with opaque
 * signed cursors. A `productId` or `contactId` from another Workspace is the
 * uniform 404, never a quiet empty list.
 */
export const GET = v1Route(
  { operationId: "listConversations", scope: "conversations:read" },
  async ({ request, scope, db }) => {
    const parsed = parseQuery(new URL(request.url).searchParams, conversationListQuery);
    if (!parsed.ok) return parsed.response;
    const { limit, cursor, status, productId, contactId, q, updatedAfter } = parsed.query;

    // The tag filter normalizes like a tag write (trim + lower-case), so filtering
    // by "Billing" and writing "billing" agree. `q` is bound trimmed for the same
    // reason: a cursor minted for " printer" resumes "printer".
    const tag = parsed.query.tag?.toLowerCase();
    const search = q?.trim();
    const binding: CursorBinding = { workspaceId: scope.workspaceId, route: ROUTE, filters: { status, productId, contactId, tag, q: search, updatedAfter } };

    let position: { id: string; createdAt: Date } | null = null;
    if (cursor !== undefined) {
      // Checked here, not in the schema, so an oversized cursor answers the
      // same invalid_cursor as every other wrong cursor ("and so does
      // garbage", docs/api-quickstart.md) instead of invalid_request.
      if (cursor.length > MAX_CURSOR_LENGTH) return invalidCursor();
      const payload = verifyCursor(binding, cursor);
      const id = typeof payload?.id === "string" ? payload.id : null;
      const when = typeof payload?.createdAt === "string" ? new Date(payload.createdAt) : null;
      if (id === null || when === null || Number.isNaN(when.getTime())) return invalidCursor();
      position = { id, createdAt: when };
    }

    if (productId !== undefined && (await db.product.count({ where: { id: productId } })) === 0) {
      throw new NotInScopeError("Product");
    }
    if (contactId !== undefined && (await db.contact.count({ where: { id: contactId } })) === 0) {
      throw new NotInScopeError("Contact");
    }

    const ticketNumber = search ? parseTicketSearch(search) : null;
    const narrowing: Record<string, unknown>[] = [];
    if (status !== undefined) narrowing.push({ status });
    if (productId !== undefined) narrowing.push({ productId });
    if (contactId !== undefined) narrowing.push({ contactId });
    if (tag !== undefined) narrowing.push({ tags: { some: { tag: { name: tag } } } });
    if (updatedAfter !== undefined) narrowing.push({ updatedAt: { gt: new Date(updatedAfter) } });
    if (position) {
      // The cursor carries only the sort keys (createdAt, id) of a row the caller
      // already saw, so a page resumes even if that row has since been deleted.
      narrowing.push({
        OR: [{ createdAt: { gt: position.createdAt } }, { AND: [{ createdAt: position.createdAt }, { id: { gt: position.id } }] }],
      });
    }
    if (search) {
      narrowing.push({
        OR: [
          { subject: { contains: search, mode: "insensitive" } },
          ...(ticketNumber !== null ? [{ ticketNumber }] : []),
          { contact: { email: { contains: search, mode: "insensitive" } } },
          { contact: { name: { contains: search, mode: "insensitive" } } },
          { messages: { some: { body: { contains: search, mode: "insensitive" } } } },
        ],
      });
    }

    const rows = await db.conversation.findMany({
      where: narrowing.length > 0 ? { AND: narrowing } : {},
      // Oldest first on every tab (#199): the queue reads top-down. The id
      // tiebreak keeps pages deterministic when createdAt ties.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: conversationSelect,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return Response.json(
      {
        items: page.map(serializeConversation),
        nextCursor: hasMore && last ? signCursor(binding, { id: last.id, createdAt: last.createdAt.toISOString() }) : null,
      },
      { headers: PRIVATE_NO_STORE },
    );
  },
);
