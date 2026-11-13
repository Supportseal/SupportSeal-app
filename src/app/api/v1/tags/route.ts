import { signCursor, verifyCursor, type CursorBinding } from "@/lib/api/cursor";
import { PRIVATE_NO_STORE } from "@/lib/api-errors";
import { invalidCursor, MAX_CURSOR_LENGTH, parseQuery } from "@/lib/api/query";
import { v1Route } from "@/lib/api/v1-route";
import { serializeTag, tagListQuery } from "@/lib/tag-api";

export const dynamic = "force-dynamic";

const ROUTE = "/api/v1/tags";

/**
 * The Workspace's tag names, alphabetical (FR-API-08): the vocabulary a
 * `PATCH` (`addTags`/`removeTags`) and the Conversations `tag` filter share.
 * A tag exists from its first write and stays listed even once no
 * Conversation carries it; names are unique per Workspace, so `name` alone
 * orders the list and is all the cursor carries. The query has no filters,
 * so the cursor is bound to this Workspace and this route only.
 */
export const GET = v1Route(
  { operationId: "listTags", scope: "conversations:read" },
  async ({ request, scope, db }) => {
    const parsed = parseQuery(new URL(request.url).searchParams, tagListQuery);
    if (!parsed.ok) return parsed.response;
    const { limit, cursor } = parsed.query;

    const binding: CursorBinding = { workspaceId: scope.workspaceId, route: ROUTE };

    let position: { name: string } | null = null;
    if (cursor !== undefined) {
      if (cursor.length > MAX_CURSOR_LENGTH) return invalidCursor();
      const payload = verifyCursor(binding, cursor);
      const name = typeof payload?.name === "string" ? payload.name : null;
      if (name === null) return invalidCursor();
      position = { name };
    }

    const rows = await db.tag.findMany({
      where: {
        // The cursor carries only the sort key (name) of a row the caller
        // already saw, so a page resumes even if that row was deleted.
        ...(position ? { name: { gt: position.name } } : {}),
      },
      orderBy: [{ name: "asc" }],
      take: limit + 1,
      select: { id: true, name: true },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return Response.json(
      {
        items: page.map(serializeTag),
        nextCursor: hasMore && last ? signCursor(binding, { name: last.name }) : null,
      },
      { headers: PRIVATE_NO_STORE },
    );
  },
);
