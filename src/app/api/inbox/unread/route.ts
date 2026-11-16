import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/session";
import { getPrimaryMembership } from "@/lib/workspace";
import { countOpenConversations } from "@/lib/conversations";
import { getUnreadCount } from "@/lib/unread";
import { cachedInboxAttention } from "@/lib/inbox-attention-cache";

export const dynamic = "force-dynamic";

/**
 * Attention counts (FR-INBOX-04) for the signed-in member's primary
 * Workspace: `openConversations` (the page-title prefix; the same number as
 * the inbox Open tab) and the per-agent unread CUSTOMER message count
 * (`count`/`capped`). Both are scoped through the membership row, so they
 * can never include another Workspace's data.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const membership = await getPrimaryMembership(user.id);
  if (!membership) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Every open dashboard tab polls this; answers are cached until the
  // Workspace's next write (inbox-attention-cache.ts).
  const workspaceId = membership.workspaceId;
  const [unread, openConversations] = await Promise.all([
    cachedInboxAttention(workspaceId, `unread:${membership.id}`, () =>
      getUnreadCount({ membershipId: membership.id, workspaceId })),
    cachedInboxAttention(workspaceId, "open", () => countOpenConversations(workspaceId)),
  ]);
  return NextResponse.json(
    { ...unread, openConversations },
    { headers: { "cache-control": "no-store" } },
  );
}
