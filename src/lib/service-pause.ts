import { planForWorkspace } from "@/config/pricing";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { computeGraceState } from "@/lib/usage";

/**
 * Free plan cutoff (decided 2026-10-28). A hosted Free Workspace that goes
 * over its monthly allowance gets FREE_GRACE_DAYS (daily reminder emails,
 * src/lib/grace-reminders.ts); after that its chat widget and form stop
 * taking new messages and agents cannot send replies until it upgrades.
 *
 * What still works while paused: inbound email is stored as usual (nothing
 * a customer sends by email is lost), the inbox stays readable, and notes,
 * tags and status changes keep working. Self-hosted installs are never
 * paused (FR-HOST-01), and paid plans are never paused.
 */

export type ServicePause = { paused: false } | { paused: true; since: Date };

/** Machine-readable error code returned by the widget and form APIs. */
export const SERVICE_PAUSED_CODE = "service_paused";

/** Shown to agents when a reply is refused. */
export const REPLIES_PAUSED_MESSAGE =
  "Replies are paused: this workspace is over its Free plan allowance. Upgrade to resume replying.";

/**
 * The pause is stored on the Workspace (`freePlanPausedAt`) the first time
 * expired grace is seen, so it survives the monthly allowance reset and
 * lasts until the Workspace pays ("until paid", 2026-10-28). It is cleared
 * as soon as the Workspace is seen on a plan that never pauses.
 */
export async function getServicePause(
  workspaceId: string,
  now = new Date(),
): Promise<ServicePause> {
  if (!isHostedMode()) return { paused: false };
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, freePlanPausedAt: true },
  });
  if (!workspace) return { paused: false };
  const plan = planForWorkspace(workspace.plan);
  if (!plan.pausesAfterGrace) {
    if (workspace.freePlanPausedAt) {
      await prisma.workspace.updateMany({
        where: { id: workspaceId, freePlanPausedAt: { not: null } },
        data: { freePlanPausedAt: null },
      });
    }
    return { paused: false };
  }
  if (workspace.freePlanPausedAt) return { paused: true, since: workspace.freePlanPausedAt };

  const usage = await computeGraceState(workspaceId, plan.id, now);
  if (!usage.graceExpired || !usage.graceEndsAt) return { paused: false };
  await prisma.workspace.updateMany({
    where: { id: workspaceId, freePlanPausedAt: null },
    data: { freePlanPausedAt: usage.graceEndsAt },
  });
  return { paused: true, since: usage.graceEndsAt };
}

/**
 * "Not paused" answers are remembered per process for a short while: the
 * widget config, session and message endpoints ask on every request, and
 * the answer only flips when grace runs out. A paused answer is never
 * cached, so an upgrade lifts the pause on the next request.
 */
const NOT_PAUSED_TTL_MS = 60_000;
const notPausedUntil = new Map<string, number>();

export async function isServicePaused(workspaceId: string): Promise<boolean> {
  if (!isHostedMode()) return false;
  const cachedUntil = notPausedUntil.get(workspaceId);
  if (cachedUntil !== undefined && cachedUntil > Date.now()) return false;
  const { paused } = await getServicePause(workspaceId);
  if (paused) notPausedUntil.delete(workspaceId);
  else {
    if (notPausedUntil.size > 10_000) notPausedUntil.clear();
    notPausedUntil.set(workspaceId, Date.now() + NOT_PAUSED_TTL_MS);
  }
  return paused;
}

export function clearServicePauseCacheForTest(): void {
  notPausedUntil.clear();
}
