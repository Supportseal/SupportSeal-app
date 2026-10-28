import { formatCount, PLANS } from "@/config/pricing";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { computeUsage, type UsageSummary } from "@/lib/usage";
import { billingUrl, emailWorkspaceAdmins, renderNoticeEmail } from "@/lib/usage-notifications";

/**
 * Daily Free plan grace reminders (decided 2026-10-28). The "over your
 * allowance" email goes out when a Free Workspace crosses its limit (day 0,
 * src/lib/usage-notifications.ts); after that its admins get one reminder
 * per grace day (days 1..6) and a final "paused" notice on day 7, when the
 * widget and replies pause (src/lib/service-pause.ts).
 *
 * Grace days count from the moment grace started, so a reminder goes out
 * roughly at the same time of day as the crossing. A day missed while the
 * app saw no traffic is not caught up later: only the current day's
 * reminder is ever sent. The `usage_notifications` row (level
 * GRACE_REMINDER, graceDay) is written before sending, so concurrent sweeps
 * and several app instances send each day once; a failed send drops the
 * row so a later sweep the same day retries it.
 *
 * Same shape as the auto-close sweep: no background worker, swept lazily
 * from dashboard and intake traffic. Stops on its own once the Workspace
 * pays (it is no longer on Free) or the next month's allowance starts.
 * Hosted only; self-hosted installs have no allowance (FR-HOST-01).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const LAZY_SWEEP_INTERVAL_MS = 10 * 60_000;

export type GraceReminderResult = { sent: number };

/** Which grace day `now` falls on (0 = the day of crossing), or null. */
export function graceDayFor(usage: UsageSummary, now: Date): number | null {
  if (!usage.overLimit || !usage.graceStartedAt || !usage.plan.pausesAfterGrace) return null;
  const elapsed = now.getTime() - usage.graceStartedAt.getTime();
  if (elapsed < 0) return null;
  return Math.min(usage.plan.graceDays, Math.floor(elapsed / DAY_MS));
}

function formatCutoff(date: Date): string {
  return `${date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })} UTC`;
}

export function graceReminderEmail(input: {
  workspaceName: string;
  usage: UsageSummary;
  graceDay: number;
}): { subject: string; text: string; html: string } {
  const { workspaceName, usage, graceDay } = input;
  const used = `${formatCount(usage.conversationsOpened)} of ${formatCount(usage.limit ?? 0)}`;
  const daysLeft = usage.plan.graceDays - graceDay;
  const paused = daysLeft <= 0;
  const cutoff = usage.graceEndsAt ? formatCutoff(usage.graceEndsAt) : "the end of your grace period";
  const nothingLost = "Emails your customers send are still saved in your inbox, so nothing is lost.";

  if (paused) {
    const subject = `${workspaceName}: chat and replies are paused`;
    const { text, html } = renderNoticeEmail({
      headline: `${workspaceName}: chat and replies are paused`,
      paragraphs: [
        `${workspaceName} used ${used} conversations on the ${usage.plan.name} plan this month and its ${usage.plan.graceDays}-day grace period has ended.`,
        `Your chat widget has stopped taking new messages and replies from the inbox are paused. ${nothingLost}`,
        `Upgrade to resume straight away. Otherwise everything resumes when next month's allowance starts.`,
      ],
      cta: "Upgrade to resume",
      url: billingUrl(),
    });
    return { subject, text, html };
  }

  const dayWord = daysLeft === 1 ? "day" : "days";
  const subject = `${workspaceName}: ${daysLeft} ${dayWord} left before chat and replies pause`;
  const { text, html } = renderNoticeEmail({
    headline: `${daysLeft} ${dayWord} left before chat and replies pause`,
    paragraphs: [
      `${workspaceName} is over its ${usage.plan.name} plan allowance: ${used} conversations used this month.`,
      `On ${cutoff} your chat widget will stop taking new messages and replies from the inbox will pause, until you upgrade or next month's allowance starts. ${nothingLost}`,
      `Upgrading takes a minute and stops these reminders.`,
    ],
    cta: "Upgrade now",
    url: billingUrl(),
  });
  return { subject, text, html };
}

/** Send today's grace reminder for one Workspace, at most once per day. */
export async function maybeSendGraceReminder(input: {
  workspaceId: string;
  now?: Date;
}): Promise<boolean> {
  if (!isHostedMode()) return false;
  const now = input.now ?? new Date();
  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { name: true, plan: true },
  });
  if (!workspace || workspace.plan !== "FREE") return false;
  const usage = await computeUsage(input.workspaceId, "free", now);
  const graceDay = graceDayFor(usage, now);
  // Day 0 is the "over your allowance" email sent at the crossing.
  if (graceDay === null || graceDay < 1) return false;

  const key = {
    workspaceId: input.workspaceId,
    period: usage.period.label,
    level: "GRACE_REMINDER" as const,
    graceDay,
  };
  try {
    await prisma.usageNotification.create({ data: key });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }

  const email = graceReminderEmail({ workspaceName: workspace.name, usage, graceDay });
  const { failures } = await emailWorkspaceAdmins({ workspaceId: input.workspaceId, ...email });
  if (failures > 0) {
    await prisma.usageNotification
      .delete({ where: { workspaceId_period_level_graceDay: key } })
      .catch((error) => console.error("failed to reset grace reminder row for retry:", error));
    return false;
  }
  return true;
}

/** One pass over every hosted Free Workspace that is over its allowance. */
export async function sweepGraceReminders(input: { now?: Date } = {}): Promise<GraceReminderResult> {
  if (!isHostedMode()) return { sent: 0 };
  const now = input.now ?? new Date();
  const limit = PLANS.free.monthlyConversations;
  if (limit === null) return { sent: 0 };
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const over = await prisma.conversation.groupBy({
    by: ["workspaceId"],
    where: { createdAt: { gte: start, lt: end }, workspace: { plan: "FREE" } },
    having: { workspaceId: { _count: { gt: limit } } },
  });

  let sent = 0;
  for (const { workspaceId } of over) {
    try {
      if (await maybeSendGraceReminder({ workspaceId, now })) sent += 1;
    } catch (error) {
      console.error(`grace reminder for workspace ${workspaceId} failed:`, error);
    }
  }
  return { sent };
}

const globalForSweep = globalThis as unknown as {
  __supportsealGraceChain?: Promise<unknown>;
  __supportsealLastGraceSweepAt?: number;
};

/**
 * Lazy sweep for dashboard and intake paths: at most one per ten minutes
 * per process, serialised, fire-and-forget; never blocks or fails a request.
 */
export function sweepGraceRemindersLazily(): void {
  if (!isHostedMode()) return;
  const last = globalForSweep.__supportsealLastGraceSweepAt ?? 0;
  if (Date.now() - last < LAZY_SWEEP_INTERVAL_MS) return;
  globalForSweep.__supportsealLastGraceSweepAt = Date.now();
  const previous = globalForSweep.__supportsealGraceChain ?? Promise.resolve();
  globalForSweep.__supportsealGraceChain = previous
    .then(() => sweepGraceReminders())
    .catch((error: unknown) => console.error("grace reminder sweep failed:", error));
}
