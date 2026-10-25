import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/session";
import { getPrimaryMembership } from "@/lib/workspace";
import { getUnreadCount } from "@/lib/unread";

export const dynamic = "force-dynamic";

/**
 * Per-agent unread CUSTOMER message count (FR-INBOX-04) for the signed-in
 * member's primary Workspace. The count is scoped through the membership row
 * itself, so it can never leak another Workspace's messages.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const membership = await getPrimaryMembership(user.id);
  if (!membership) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const unread = await getUnreadCount({
    membershipId: membership.id,
    workspaceId: membership.workspaceId,
  });
  return NextResponse.json(unread, { headers: { "cache-control": "no-store" } });
}
