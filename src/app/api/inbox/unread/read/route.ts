import { NextResponse, type NextRequest } from "next/server";

import { getSessionUser } from "@/lib/session";
import { getPrimaryMembership } from "@/lib/workspace";
import { serviceOriginFrom } from "@/lib/widget";
import { markCustomerMessagesRead } from "@/lib/unread";
import { MAX_MARK_IDS } from "@/lib/unread-shared";

export const dynamic = "force-dynamic";

/** Cookie-authenticated writes must carry a same-service Origin header. */
function sameServiceOrigin(originHeader: string | null, serviceOrigin: string): boolean {
  if (!originHeader) return false; // reject missing, unlike read-only widget routes
  try {
    return new URL(originHeader).origin === serviceOrigin;
  } catch {
    return false;
  }
}

/**
 * Record read receipts for displayed customer messages (FR-INBOX-04).
 * Identity comes from the session cookie, never the client body; the Origin
 * header must match the service origin (same-origin write), and only CUSTOMER
 * messages of a conversation in the caller's Workspace are marked.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const membership = await getPrimaryMembership(user.id);
  if (!membership) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (
    !sameServiceOrigin(
      request.headers.get("origin"),
      serviceOriginFrom(request.headers, request.nextUrl.origin),
    )
  ) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as
    | { conversationId?: unknown; messageIds?: unknown }
    | null;
  const conversationId = body?.conversationId;
  const messageIds = body?.messageIds;
  if (
    typeof conversationId !== "string" ||
    !conversationId ||
    !Array.isArray(messageIds) ||
    messageIds.length === 0 ||
    messageIds.length > MAX_MARK_IDS ||
    !messageIds.every((id) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "Expected conversationId and 1..MAX_MARK_IDS messageIds." },
      { status: 400 },
    );
  }

  const result = await markCustomerMessagesRead({
    membershipId: membership.id,
    workspaceId: membership.workspaceId,
    conversationId,
    messageIds,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, marked: result.marked });
}
