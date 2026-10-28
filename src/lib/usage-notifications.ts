import {
  ALLOWANCE_APPROACHING_THRESHOLD,
  formatCount,
  planForWorkspace,
} from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { appConfig } from "@/lib/config";
import { sendSystemEmail } from "@/lib/email/outbound";
import { isHostedMode } from "@/lib/hosting";
import { prisma } from "@/lib/prisma";
import { computeUsage } from "@/lib/usage";

/**
 * Admin allowance emails (FR-USE-02). One email per level (approaching at
 * ALLOWANCE_APPROACHING_THRESHOLD, then exceeded) per Workspace per period.
 * The `usage_notifications` row is written first and is both the dedupe key
 * and the audit record; when a send genuinely fails the row is deleted again
 * so the next conversation retries the level (at-least-once). Record-only
 * mode (no SMTP) keeps the row, matching reply-email dev semantics.
 * Delivery failures are logged and never block intake.
 */

export type AllowanceNotificationStatus =
  | { status: "skipped" } // self-hosted: no hosted allowance
  | { status: "none" } // below the approaching threshold (or unlimited)
  | { status: "deduped"; level: AllowanceLevel } // already notified this period
  | { status: "send-failed"; level: AllowanceLevel; emailed: number } // row reset; retries next conversation
  | { status: "notified"; level: AllowanceLevel; emailed: number };

export type AllowanceLevel = "APPROACHING" | "EXCEEDED";

function levelFor(input: {
  limit: number | null;
  conversationsOpened: number;
  overLimit: boolean;
}): AllowanceLevel | null {
  if (input.limit === null) return null;
  if (input.overLimit) return "EXCEEDED";
  if (input.conversationsOpened >= input.limit * ALLOWANCE_APPROACHING_THRESHOLD) {
    return "APPROACHING";
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

const BRAND_GREEN = "#08765a";
const FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * Plain-text and HTML bodies share one set of paragraphs so the text part
 * carries every fact the styled part does. The HTML is a single-column,
 * inline-styled table with no images or external assets. Shared with the
 * daily grace reminders (src/lib/grace-reminders.ts).
 */
export function renderNoticeEmail(input: {
  headline: string;
  paragraphs: string[];
  cta: string;
  url: string;
}): { text: string; html: string } {
  const { headline, paragraphs, cta, url } = input;
  const text = [headline, "", ...paragraphs.flatMap((p) => [p, ""]), `${cta}: ${url}`].join("\n");

  const paragraphCells = paragraphs
    .map(
      (p) =>
        `<tr><td style="padding:0 0 14px 0;font-family:${FONT};font-size:16px;line-height:24px;color:#1f2933;">${escapeHtml(p)}</td></tr>`,
    )
    .join("");
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(headline)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f5f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border-radius:8px;"><tr><td style="padding:28px 28px 14px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 18px 0;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:#111827;">${escapeHtml(headline)}</td></tr>
${paragraphCells}
<tr><td style="padding:6px 0 18px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:${BRAND_GREEN};border-radius:6px;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(cta)}</a></td></tr></table></td></tr>
<tr><td style="padding:0;font-family:${FONT};font-size:13px;line-height:20px;color:#6b7280;">Sent by ${escapeHtml(siteConfig.name)}. This address does not take replies.</td></tr>
</table>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { text, html };
}

export function billingUrl(): string {
  return `${appConfig.url}/settings/billing`;
}

function allowanceEmail(input: {
  workspaceName: string;
  planName: string;
  opened: number;
  limit: number;
  graceDays: number;
  pausesAfterGrace: boolean;
  level: AllowanceLevel;
}): { text: string; html: string } {
  const used = `${formatCount(input.opened)} of ${formatCount(input.limit)}`;
  const over = input.level === "EXCEEDED";
  const headline = over
    ? `${input.workspaceName} is over its ${input.planName} plan allowance`
    : `${input.workspaceName} is nearing its ${input.planName} plan allowance`;
  const graceParagraph = input.pausesAfterGrace
    ? over
      ? `You have ${input.graceDays} days from the point you went over. After that your chat widget stops taking new messages and replies are paused until you upgrade or next month's allowance starts. We'll email a reminder each day until then.`
      : `If you go over, you have ${input.graceDays} days to upgrade before your chat widget and replies pause.`
    : over
      ? `A ${input.graceDays}-day grace window applies from the point you went over. If this volume continues, a higher-volume plan is the better fit.`
      : `If you go over, a ${input.graceDays}-day grace window applies.`;
  const paragraphs = [
    `${used} conversations used this period. A conversation counts once, in the period it opens.`,
    input.pausesAfterGrace
      ? `We never upgrade your plan on our own and never send a surprise bill.`
      : `Customer messages keep flowing: we never block intake, never upgrade your plan on our own and never send a surprise bill.`,
    graceParagraph,
  ];
  return renderNoticeEmail({ headline, paragraphs, cta: "Review your plan and upgrade", url: billingUrl() });
}

/**
 * Email every admin of the Workspace. Returns how many sends succeeded and
 * failed; failures are logged with the address only.
 */
export async function emailWorkspaceAdmins(input: {
  workspaceId: string;
  subject: string;
  text: string;
  html: string;
}): Promise<{ emailed: number; failures: number }> {
  const admins = await prisma.membership.findMany({
    where: { workspaceId: input.workspaceId, role: "ADMIN" },
    include: { user: { select: { email: true } } },
  });
  let emailed = 0;
  let failures = 0;
  for (const admin of admins) {
    const result = await sendSystemEmail({
      to: admin.user.email,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    if (result.ok) emailed += 1;
    else {
      failures += 1;
      console.error(`usage notice to ${admin.user.email} failed: ${result.error}`);
    }
  }
  return { emailed, failures };
}

/**
 * Compute usage, and when a threshold is newly crossed notify all Workspace
 * admins by email once per level per period. Hosted mode only — self-hosted
 * deployments have no hosted Conversation allowance (FR-HOST-01).
 */
export async function maybeNotifyAllowance(input: {
  workspaceId: string;
  now?: Date;
}): Promise<AllowanceNotificationStatus> {
  if (!isHostedMode()) return { status: "skipped" };

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { name: true, plan: true },
  });
  if (!workspace) return { status: "skipped" };

  const plan = planForWorkspace(workspace.plan);
  const usage = await computeUsage(input.workspaceId, plan.id, input.now);
  const level = levelFor({
    limit: usage.limit,
    conversationsOpened: usage.conversationsOpened,
    overLimit: usage.overLimit,
  });
  if (!level || usage.limit === null) return { status: "none" };

  // Dedupe + audit row first: concurrent conversation creates notify once.
  try {
    await prisma.usageNotification.create({
      data: { workspaceId: input.workspaceId, period: usage.period.label, level },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      return { status: "deduped", level };
    }
    throw error;
  }

  const subject = `${workspace.name}: ${
    level === "EXCEEDED" ? "over" : "approaching"
  } your ${usage.plan.name} plan conversation allowance`;
  const { text, html } = allowanceEmail({
    workspaceName: workspace.name,
    planName: usage.plan.name,
    opened: usage.conversationsOpened,
    limit: usage.limit,
    graceDays: plan.graceDays,
    pausesAfterGrace: plan.pausesAfterGrace,
    level,
  });

  const { emailed, failures } = await emailWorkspaceAdmins({
    workspaceId: input.workspaceId,
    subject,
    text,
    html,
  });
  if (failures > 0) {
    // Drop the dedupe row so the next conversation in this period retries the
    // level (at-least-once delivery; a retried level may re-mail an admin
    // who already received it). Record-only mode (no SMTP configured) is
    // `ok: true` and keeps the row, matching the reply-email dev semantics.
    await prisma.usageNotification
      .delete({
        where: { workspaceId_period_level_graceDay: {
          workspaceId: input.workspaceId,
          period: usage.period.label,
          level,
          graceDay: 0,
        } },
      })
      .catch((error) => {
        console.error(`failed to reset allowance notification row for retry:`, error);
      });
    return { status: "send-failed", level, emailed };
  }
  return { status: "notified", level, emailed };
}

/**
 * Fire-and-forget wrapper for intake paths (conversation creation): the
 * notification is auxiliary and must never block or fail message intake
 * (FR-USE-02). Errors are logged, not swallowed silently.
 */
export function notifyAllowanceInBackground(workspaceId: string): void {
  void maybeNotifyAllowance({ workspaceId }).catch((error) => {
    console.error(`allowance notification for workspace ${workspaceId} failed:`, error);
  });
}
