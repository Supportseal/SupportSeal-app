import { appConfig } from "@/lib/config";
import { hasOpenDashboard } from "@/lib/dashboard-presence";
import { isOutboundEmailConfigured, sendSystemEmail } from "@/lib/email/outbound";
import { renderCustomerThread } from "@/lib/escalation";
import { prisma } from "@/lib/prisma";
import { formatTicketRef } from "@/lib/ticket";

/**
 * New-message email alerts for agents (docs/design/agent-alerts.md). A
 * customer Message that is still unanswered after AGENT_ALERT_DELAY_MS is
 * emailed to every member who wants that kind of alert, has no dashboard
 * open and has not read it yet. Messages that arrive close together in one
 * Conversation go out as one email.
 *
 * Same shape as the escalation sweep (src/lib/escalation.ts): no background
 * worker, an in-process timer armed at intake plus a throttled lazy sweep,
 * all backed by an atomic claim (`messages.agentAlertedAt`), so concurrent
 * sweeps and several app processes never send a message's alert twice.
 */

export const AGENT_ALERT_DELAY_MS = 2 * 60_000;

/** A message this far past its due time is stale: claimed, never emailed. */
const STALE_AFTER_MS = 6 * 60 * 60_000;
const BATCH = 200;
const LAZY_SWEEP_INTERVAL_MS = 60_000;

export type AgentAlertKind = "new-conversation" | "customer-reply";

export type AgentAlertSweepResult =
  | { status: "mail-not-configured" }
  | { status: "ok"; conversations: number; emails: number; failed: number };

type AlertInput = {
  kind: AgentAlertKind;
  conversationId: string;
  ticketNumber: number;
  channel: "CHAT" | "EMAIL";
  subject: string | null;
  productName: string;
  contact: { name: string | null; email: string | null };
  messages: { body: string; createdAt: Date }[];
};

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

export function agentAlertEmail(input: AlertInput): { subject: string; text: string } {
  const who = [input.contact.name, input.contact.email].filter(Boolean).join(" · ") || "Anonymous visitor";
  const ref = formatTicketRef(input.ticketNumber);
  const product = oneLine(input.productName, 40);
  const headline = oneLine(input.subject ?? input.messages[0]?.body ?? "", 80);
  const channel = input.channel === "CHAT" ? "live chat" : "email";
  const count = input.messages.length;
  const intro =
    input.kind === "new-conversation"
      ? `New ${channel} conversation for ${input.productName} (${ref}).`
      : `${who} sent ${count === 1 ? "a new message" : `${count} new messages`} in ${ref} (${input.productName}).`;
  return {
    subject:
      input.kind === "new-conversation"
        ? `[${product}] New: ${headline} (${ref})`
        : `[${product}] Reply from ${oneLine(input.contact.name ?? input.contact.email ?? "visitor", 40)} (${ref})`,
    text: [
      intro,
      ``,
      `From: ${who}`,
      ``,
      ...renderCustomerThread(input.messages),
      `Reply in the dashboard: ${appConfig.url}/inbox/${input.conversationId}`,
      ``,
      `You get this email because nobody has answered yet and you were not in the dashboard. Choose which alerts you get in Settings → Notifications: ${appConfig.url}/settings/notifications`,
    ].join("\n"),
  };
}

/**
 * Email every due, unclaimed customer Message. Returns counts; never throws
 * on a send failure (when every send for a Conversation fails, its claim is
 * released so the next sweep retries).
 */
export async function sweepAgentAlerts(input: { now?: Date } = {}): Promise<AgentAlertSweepResult> {
  // Do not claim without a provider: nothing could be delivered.
  if (!isOutboundEmailConfigured()) return { status: "mail-not-configured" };
  const now = input.now ?? new Date();
  const dueBefore = new Date(now.getTime() - AGENT_ALERT_DELAY_MS);

  const due = await prisma.message.findMany({
    where: {
      kind: "CUSTOMER",
      agentAlertedAt: null,
      createdAt: { lte: dueBefore },
    },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: { conversationId: true, createdAt: true },
  });
  const conversationIds = [...new Set(due.map((m) => m.conversationId))];

  let conversations = 0;
  let emails = 0;
  let failed = 0;
  for (const conversationId of conversationIds) {
    const outcome = await alertConversation(conversationId, now);
    if (outcome === "failed") failed += 1;
    else if (outcome !== "skipped") {
      conversations += 1;
      emails += outcome.emails;
    }
  }
  return { status: "ok", conversations, emails, failed };
}

async function alertConversation(
  conversationId: string,
  now: Date,
): Promise<"skipped" | "failed" | { emails: number }> {
  // Claim every unclaimed customer Message in the Conversation, including
  // ones not yet due, so a burst of messages becomes one email.
  const claim = await prisma.message.updateMany({
    where: { conversationId, kind: "CUSTOMER", agentAlertedAt: null, createdAt: { lte: now } },
    data: { agentAlertedAt: now },
  });
  if (claim.count === 0) return "skipped";

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      workspaceId: true,
      ticketNumber: true,
      channel: true,
      subject: true,
      status: true,
      product: { select: { name: true, archivedAt: true } },
      contact: { select: { name: true, email: true } },
      messages: {
        where: { kind: { in: ["CUSTOMER", "AGENT"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, kind: true, body: true, createdAt: true, agentAlertedAt: true },
      },
    },
  });
  if (!conversation || conversation.product.archivedAt || conversation.status === "CLOSED") return "skipped";

  const claimed = conversation.messages.filter(
    (m) => m.kind === "CUSTOMER" && m.agentAlertedAt?.getTime() === now.getTime(),
  );
  const latest = claimed.at(-1);
  if (!latest) return "skipped";
  // Stale (the server was down, or mail was just configured): drop quietly.
  if (now.getTime() - latest.createdAt.getTime() > AGENT_ALERT_DELAY_MS + STALE_AFTER_MS) return "skipped";
  // Answered: an agent replied after the newest claimed message.
  if (conversation.messages.some((m) => m.kind === "AGENT" && m.createdAt >= latest.createdAt)) return "skipped";

  const first = claimed[0];
  const isNew = !conversation.messages.some((m) => m.createdAt < first.createdAt);
  const kind: AgentAlertKind = isNew ? "new-conversation" : "customer-reply";

  const members = await prisma.membership.findMany({
    where: {
      workspaceId: conversation.workspaceId,
      ...(isNew ? { emailOnNewConversation: true } : { emailOnCustomerReply: true }),
    },
    select: {
      id: true,
      user: { select: { email: true } },
      readReceipts: { where: { messageId: { in: claimed.map((m) => m.id) } }, select: { messageId: true } },
    },
  });
  const recipients = members.filter(
    (m) => !hasOpenDashboard(m.id) && m.readReceipts.length < claimed.length,
  );
  if (recipients.length === 0) return "skipped";

  const mail = agentAlertEmail({
    kind,
    conversationId: conversation.id,
    ticketNumber: conversation.ticketNumber,
    channel: conversation.channel,
    subject: conversation.subject,
    productName: conversation.product.name,
    contact: conversation.contact,
    messages: claimed,
  });
  let delivered = 0;
  for (const recipient of recipients) {
    const result = await sendSystemEmail({ to: recipient.user.email, ...mail });
    if (result.ok && result.delivered) delivered += 1;
    else if (!result.ok) console.error(`agent alert email to ${recipient.user.email} failed: ${result.error}`);
  }
  if (delivered > 0) return { emails: delivered };

  await prisma.message
    .updateMany({
      where: { id: { in: claimed.map((m) => m.id) }, agentAlertedAt: now },
      data: { agentAlertedAt: null },
    })
    .catch((error: unknown) => console.error("failed to release agent alert claim:", error));
  return "failed";
}

const globalForSweep = globalThis as unknown as {
  __supportsealAgentAlertChain?: Promise<unknown>;
  __supportsealAgentAlertLastSweepAt?: number;
  __supportsealAgentAlertArmed?: Set<string>;
};

function runSweepInBackground(): void {
  const previous = globalForSweep.__supportsealAgentAlertChain ?? Promise.resolve();
  globalForSweep.__supportsealAgentAlertLastSweepAt = Date.now();
  globalForSweep.__supportsealAgentAlertChain = previous
    .then(() => sweepAgentAlerts())
    .catch((error: unknown) => console.error("agent alert sweep failed:", error));
}

/** Throttled lazy sweep for intake paths: at most once a minute per process. */
export function sweepAgentAlertsLazily(): void {
  const last = globalForSweep.__supportsealAgentAlertLastSweepAt ?? 0;
  if (Date.now() - last < LAZY_SWEEP_INTERVAL_MS) return;
  runSweepInBackground();
}

/**
 * Arm the in-process timer for a customer Message that just landed. One
 * timer per Conversation: a later message in the same burst is claimed by
 * the first timer's sweep. Lost on restart (the lazy sweep covers that).
 */
export function armAgentAlertTimer(conversationId: string): void {
  const armed = (globalForSweep.__supportsealAgentAlertArmed ??= new Set<string>());
  if (armed.has(conversationId) || !isOutboundEmailConfigured()) return;
  armed.add(conversationId);
  setTimeout(() => {
    armed.delete(conversationId);
    runSweepInBackground();
  }, AGENT_ALERT_DELAY_MS + 1_000).unref?.();
}

export type AgentAlertPreferences = { newConversation: boolean; customerReply: boolean };

/** The signed-in member's own alert choices (Settings → Notifications). */
export async function getAgentAlertPreferences(input: {
  userId: string;
  workspaceId: string;
}): Promise<AgentAlertPreferences | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId: input.userId, workspaceId: input.workspaceId },
    select: { emailOnNewConversation: true, emailOnCustomerReply: true },
  });
  return membership
    ? { newConversation: membership.emailOnNewConversation, customerReply: membership.emailOnCustomerReply }
    : null;
}

/** Every member, Admin or Agent, changes only their own choices. */
export async function setAgentAlertPreferences(input: {
  userId: string;
  workspaceId: string;
  preferences: AgentAlertPreferences;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const updated = await prisma.membership.updateMany({
    where: { userId: input.userId, workspaceId: input.workspaceId },
    data: {
      emailOnNewConversation: input.preferences.newConversation,
      emailOnCustomerReply: input.preferences.customerReply,
    },
  });
  return updated.count === 1 ? { ok: true } : { ok: false, error: "Membership not found." };
}
