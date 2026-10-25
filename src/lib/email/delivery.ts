import { prisma } from "@/lib/prisma";

/**
 * Read-side delivery queries for the Product settings Email tab
 * (docs/design/product-settings.md "Email"). Workspace-scoped so the tab
 * never reads another tenant's deliveries (FR-SEC-01).
 */

export async function lastInboundReceived(
  workspaceId: string,
  productId: string,
): Promise<{ createdAt: Date; fromAddress: string | null } | null> {
  return prisma.emailDelivery.findFirst({
    where: { workspaceId, productId, direction: "INBOUND", status: "RECEIVED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, fromAddress: true },
  });
}

/** Undelivered replies in the last 30 days (FR-EMAIL-03 follow-up signal). */
export async function countFailedReplies(workspaceId: string, productId: string): Promise<number> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return prisma.emailDelivery.count({
    where: {
      workspaceId,
      productId,
      direction: "OUTBOUND",
      status: { in: ["FAILED", "REJECTED"] },
      createdAt: { gte: since },
    },
  });
}
