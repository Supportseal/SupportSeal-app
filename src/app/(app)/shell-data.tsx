import { planForWorkspace } from "@/config/pricing";
import { AppShell } from "@/components/layout/app-shell";
import { prisma } from "@/lib/prisma";
import { listProducts } from "@/lib/products";
import { getAvailability, requireWorkspace } from "@/lib/workspace";
import { computeChecklist } from "@/lib/onboarding";
import { computeUsage } from "@/lib/usage";
import { sweepGraceRemindersLazily } from "@/lib/grace-reminders";
import { isHostedMode } from "@/lib/hosting";
import { setAvailabilityAction } from "./actions";

/**
 * Loads shell data (workspace context, sidebar Products with open counts,
 * availability) and renders the AppShell in the requested mode. Used by the
 * (page) and (fill) route-group layouts.
 */
export async function Shell({
  mode,
  children,
}: {
  mode: "page" | "fill";
  children: React.ReactNode;
}) {
  const ctx = await requireWorkspace();

  const [products, counts, availability, checklist, usage] = await Promise.all([
    listProducts(ctx.workspace.id),
    prisma.conversation.groupBy({
      by: ["productId"],
      where: { workspaceId: ctx.workspace.id, status: "OPEN" },
      _count: { _all: true },
    }),
    getAvailability(ctx.workspace.id),
    computeChecklist(ctx.workspace.id),
    // Every role: agents need to know why replies are paused.
    isHostedMode()
      ? computeUsage(ctx.workspace.id, planForWorkspace(ctx.workspace.plan).id)
      : Promise.resolve(null),
  ]);

  sweepGraceRemindersLazily();
  const countByProduct = new Map(counts.map((c) => [c.productId, c._count._all]));

  return (
    <AppShell
      user={{ id: ctx.user.id, name: ctx.user.name, email: ctx.user.email }}
      workspaceId={ctx.workspace.id}
      role={ctx.role}
      availability={availability}
      onAvailabilityChange={setAvailabilityAction}
      mode={mode}
      products={products
        .filter((p) => p.archivedAt === null)
        .map((p) => ({
          id: p.id,
          name: p.name,
          primaryColor: p.primaryColor,
          openCount: countByProduct.get(p.id) ?? 0,
        }))}
      checklist={checklist}
      usageWarning={
        usage && usage.overLimit && (ctx.role === "ADMIN" || usage.graceExpired)
          ? {
              conversationsOpened: usage.conversationsOpened,
              limit: usage.limit,
              graceRemainingDays: usage.graceRemainingDays ?? 0,
              pausesAfterGrace: usage.plan.pausesAfterGrace,
              paused: usage.graceExpired,
            }
          : null
      }
    >
      {children}
    </AppShell>
  );
}
