import type { NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { getPrimaryMembership } from "@/lib/workspace";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Max messages per poll; the 51st row only signals `hasMore`. */
const MAX_MESSAGES = 50;

/**
 * Desktop-notification feed for open dashboard tabs
 * (docs/desktop-notifications.md). Returns ids/timestamps of CUSTOMER
 * messages in the caller's Workspace only — never bodies or contacts
 * (privacy-safe), never AGENT/NOTE writes. Without `after` it returns the
 * baseline (newest customer message) so a freshly started listener never
 * notifies for history; with `after` it returns durable rows newer than the
 * cursor, which also covers writes from other app processes.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const membership = await getPrimaryMembership(user.id);
  if (!membership) return Response.json({ error: "forbidden" }, { status: 403 });
  const workspaceId = membership.workspaceId;

  const identity = { userId: user.id, workspaceId };
  const headers = { "Cache-Control": "private, no-store" };
  const scope = { kind: "CUSTOMER" as const, conversation: { workspaceId } };

  const afterRaw = request.nextUrl.searchParams.get("after");
  if (afterRaw === null) {
    const latest = await prisma.message.findFirst({
      where: scope,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true },
    });
    return Response.json({ ...identity, baseline: latest ?? { id: "", createdAt: new Date(0) } }, { headers });
  }

  const after = new Date(afterRaw);
  if (Number.isNaN(after.getTime())) {
    return Response.json({ error: "invalid after" }, { status: 400 });
  }

  const afterId = request.nextUrl.searchParams.get("afterId") ?? "";
  if (afterId.length > 64) return Response.json({ error: "invalid afterId" }, { status: 400 });
  const rows = await prisma.message.findMany({
    where: { ...scope, OR: [
      { createdAt: { gt: after } },
      { createdAt: after, id: { gt: afterId } },
    ] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_MESSAGES + 1,
    select: { id: true, conversationId: true, createdAt: true },
  });
  const hasMore = rows.length > MAX_MESSAGES;
  return Response.json({
    ...identity,
    messages: (hasMore ? rows.slice(0, MAX_MESSAGES) : rows).map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      createdAt: m.createdAt.toISOString(),
    })),
    hasMore,
  }, { headers });
}
