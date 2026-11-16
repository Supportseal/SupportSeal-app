import { signCursor, verifyCursor, type CursorBinding } from "@/lib/api/cursor";
import { PRIVATE_NO_STORE } from "@/lib/api-errors";
import { invalidCursor, MAX_CURSOR_LENGTH, parseQuery } from "@/lib/api/query";
import { v1Route } from "@/lib/api/v1-route";
import { contactListQuery, serializeContact } from "@/lib/contact-api";

export const dynamic = "force-dynamic";

const ROUTE = "/api/v1/contacts";

/**
 * The Workspace's Contacts (FR-API-09), oldest first: the people behind the
 * Conversations. `email` narrows to the Contact that address identifies —
 * at most one, because emails are unique per Workspace. Every list shares
 * the limit/cursor contract, and the cursor is bound to this Workspace, this
 * route and the email filter.
 */
export const GET = v1Route(
  { operationId: "listContacts", scope: "contacts:read" },
  async ({ request, scope, db }) => {
    const parsed = parseQuery(new URL(request.url).searchParams, contactListQuery);
    if (!parsed.ok) return parsed.response;
    const { limit, cursor } = parsed.query;

    // The schema (z.email) already rejects surrounding whitespace, so all the
    // normalization left is the store's case form: upsertContact keeps emails
    // lower-case, and the filter must agree. The bound value is the
    // lower-cased one, so pages may switch case freely between requests.
    const email = parsed.query.email?.toLowerCase();
    const binding: CursorBinding = { workspaceId: scope.workspaceId, route: ROUTE, filters: { email } };

    let position: { id: string; createdAt: Date } | null = null;
    if (cursor !== undefined) {
      if (cursor.length > MAX_CURSOR_LENGTH) return invalidCursor();
      const payload = verifyCursor(binding, cursor);
      const id = typeof payload?.id === "string" ? payload.id : null;
      const when = typeof payload?.createdAt === "string" ? new Date(payload.createdAt) : null;
      if (id === null || when === null || Number.isNaN(when.getTime())) return invalidCursor();
      position = { id, createdAt: when };
    }

    const rows = await db.contact.findMany({
      where: {
        ...(email !== undefined ? { email } : {}),
        // The cursor carries only the sort keys (createdAt, id) of a row the
        // caller already saw, so a page resumes even if that row was deleted.
        ...(position
          ? { OR: [{ createdAt: { gt: position.createdAt } }, { AND: [{ createdAt: position.createdAt }, { id: { gt: position.id } }] }] }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: { id: true, name: true, email: true, createdAt: true },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return Response.json(
      {
        items: page.map(serializeContact),
        nextCursor: hasMore && last ? signCursor(binding, { id: last.id, createdAt: last.createdAt.toISOString() }) : null,
      },
      { headers: PRIVATE_NO_STORE },
    );
  },
);
