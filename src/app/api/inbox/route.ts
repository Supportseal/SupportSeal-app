import { NextResponse, type NextRequest } from "next/server";

import { listConversations } from "@/lib/conversations";
import { prisma } from "@/lib/prisma";
import { requireWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const STATUSES = ["OPEN", "PENDING", "CLOSED"] as const;

export async function GET(request: NextRequest) {
  const ctx = await requireWorkspace();
  const params = request.nextUrl.searchParams;

  const statusParam = (params.get("status") ?? "OPEN").toUpperCase();
  const status = STATUSES.includes(statusParam as (typeof STATUSES)[number])
    ? (statusParam as (typeof STATUSES)[number])
    : "OPEN";
  const productId = params.get("product") || undefined;
  const search = params.get("q") || undefined;
  const cursor = params.get("cursor") || undefined;

  const [page, counts] = await Promise.all([
    listConversations({
      workspaceId: ctx.workspace.id,
      status: search ? "ALL" : status,
      productId,
      search,
      cursor,
      limit: 30,
    }),
    prisma.conversation.groupBy({
      by: ["status"],
      where: {
        workspaceId: ctx.workspace.id,
        ...(productId ? { productId } : {}),
      },
      _count: { _all: true },
    }),
  ]);

  const statusCounts = { OPEN: 0, PENDING: 0, CLOSED: 0 } as Record<string, number>;
  for (const row of counts) statusCounts[row.status] = row._count._all;

  return NextResponse.json({
    items: page.items,
    nextCursor: page.nextCursor,
    statusCounts,
  });
}
