import { planForWorkspace } from "@/config/pricing";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { computeUsage, type UsageSummary } from "@/lib/usage";

/**
 * Free plan cutoff (decided 2026-10-28). A hosted Free Workspace that goes
 * over its monthly allowance gets FREE_GRACE_DAYS (daily reminder emails,
 * src/lib/grace-reminders.ts); after that its chat widget and form stop
 * taking new messages and agents cannot send replies until it upgrades or
 * the next month's allowance starts.
 *
 * What still works while paused: inbound email is stored as usual (nothing
 * a customer sends by email is lost), the inbox stays readable, and notes,
 * tags and status changes keep working. Self-hosted installs are never
 * paused (FR-HOST-01), and paid plans are never paused.
 */

export type ServicePause =
  | { paused: false }
  | { paused: true; since: Date; usage: UsageSummary };

/** Machine-readable error code returned by the widget and form APIs. */
export const SERVICE_PAUSED_CODE = "service_paused";

/** Shown to agents when a reply is refused. */
export const REPLIES_PAUSED_MESSAGE =
  "Replies are paused: this workspace is over its Free plan allowance. Upgrade to resume replying.";

export async function getServicePause(
  workspaceId: string,
  now = new Date(),
): Promise<ServicePause> {
  if (!isHostedMode()) return { paused: false };
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true },
  });
  if (!workspace) return { paused: false };
  const plan = planForWorkspace(workspace.plan);
  if (!plan.pausesAfterGrace) return { paused: false };
  const usage = await computeUsage(workspaceId, plan.id, now);
  if (!usage.graceExpired || !usage.graceEndsAt) return { paused: false };
  return { paused: true, since: usage.graceEndsAt, usage };
}

export async function isServicePaused(workspaceId: string, now = new Date()): Promise<boolean> {
  return (await getServicePause(workspaceId, now)).paused;
}
