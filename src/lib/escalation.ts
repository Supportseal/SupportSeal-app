import { appConfig } from "@/lib/config";
import { isOutboundEmailConfigured, sendSystemEmail } from "@/lib/email/outbound";
import { prisma } from "@/lib/prisma";

/**
 * Unanswered-request escalation (docs/design/escalation.md). When a new
 * Conversation (chat or email) has had no agent reply for the Product's
 * threshold, every Workspace admin gets one email with the customer's messages
 * and a dashboard link.
 *
 * There is no background worker (self-hosted must work with zero external
 * dependencies), so the sweep is a plain function with three entry points:
 * a throttled lazy sweep piggybacked on app activity, a best-effort
 * in-process timer armed when a Conversation is created, and a cron-callable
 * endpoint (/api/internal/escalations/sweep). All three are idempotent: the
 * `escalatedAt` claim is a single conditional UPDATE, so concurrent sweeps,
 * several app instances and an agent reply landing as the timer fires can
 * never produce a second email or an email after a reply.
 */

export const ESCALATION_DEFAULT_MINUTES = 20;
export const ESCALATION_MIN_MINUTES = 5;
export const ESCALATION_MAX_MINUTES = 1440;

/** A Conversation more than this far past its threshold is stale, not new. */
const OVERDUE_WINDOW_MS = 24 * 60 * 60_000;
const BATCH_PER_PRODUCT = 25;
const LAZY_SWEEP_INTERVAL_MS = 60_000;
/** Email size guards: a pathological thread must not produce a giant email. */
const MESSAGE_PREVIEW_CHARS = 2000;
const MAX_EMAIL_MESSAGES = 20;
const MAX_EMAIL_BODY_CHARS = 10_000;

export function isValidEscalationMinutes(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= ESCALATION_MIN_MINUTES &&
    value <= ESCALATION_MAX_MINUTES
  );
}

export type SweepResult =
  | { status: "mail-not-configured" }
  | { status: "ok"; escalated: number; failed: number; skipped: number };

/** What "still unanswered" means; shared by the candidate scan and the claim. */
function unansweredWhere(productId: string, cutoff: Date) {
  return {
    productId,
    escalatedAt: null,
    status: "OPEN" as const,
    firstAgentReplyAt: null,
    createdAt: { lte: cutoff },
    // The agent Message row is written before the Conversation row is
    // updated, so checking Messages closes that window too.
    messages: { none: { kind: "AGENT" as const }, some: { kind: "CUSTOMER" as const } },
  };
}

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, max);
}

function waitingLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

type Escalation = {
  id: string;
  channel: "CHAT" | "EMAIL";
  subject: string | null;
  createdAt: Date;
  productName: string;
  contact: { name: string | null; email: string | null };
  /** Every customer Message, oldest first. */
  messages: { body: string; createdAt: Date }[];
};

/**
 * The customer thread as plain text, oldest first, each Message headed by its
 * UTC send time. Empty Messages are skipped; per-Message and total caps end
 * with a count of what was left out.
 */
function renderThread(messages: Escalation["messages"]): string[] {
  const blocks: string[] = [];
  const bodies = messages.map((m) => ({ at: m.createdAt, body: m.body.trim() })).filter((m) => m.body);
  let chars = 0;
  let shown = 0;
  for (const { at, body } of bodies) {
    const text = body.length > MESSAGE_PREVIEW_CHARS ? `${body.slice(0, MESSAGE_PREVIEW_CHARS - 1)}…` : body;
    if (shown >= MAX_EMAIL_MESSAGES || (shown > 0 && chars + text.length > MAX_EMAIL_BODY_CHARS)) break;
    blocks.push(`[${at.toISOString().slice(11, 16)} UTC]`, text, ``);
    chars += text.length;
    shown += 1;
  }
  const omitted = bodies.length - shown;
  if (omitted > 0) blocks.push(`(+${omitted} more message${omitted === 1 ? "" : "s"} in the Conversation.)`, ``);
  return blocks;
}

export function escalationEmail(input: Escalation, now: Date): { subject: string; text: string } {
  const channel = input.channel === "CHAT" ? "live chat" : "email";
  const headline = oneLine(input.subject ?? input.messages[0]?.body ?? "", 80);
  const who = [input.contact.name, input.contact.email].filter(Boolean).join(" · ") || "Anonymous visitor";
  const waited = waitingLabel(now.getTime() - input.createdAt.getTime());
  return {
    subject: `[${oneLine(input.productName, 40)}] ${headline}`,
    text: [
      `A new ${channel} request for ${input.productName} has had no reply for ${waited}.`,
      ``,
      `From: ${who}`,
      `Received: ${input.createdAt.toUTCString()}`,
      ``,
      ...renderThread(input.messages),
      `Reply in the dashboard: ${appConfig.url}/inbox/${input.id}`,
      ``,
      `You are receiving this because you are an admin of this Workspace. Change the wait time, or turn these alerts off, in the Product's Email settings.`,
    ].join("\n"),
  };
}

/**
 * Escalate every new Conversation that has outlived its Product's threshold
 * without an agent reply. Returns counts; never throws on a send failure
 * (the Conversation is un-claimed so the next sweep retries it).
 */
export async function sweepEscalations(input: { now?: Date } = {}): Promise<SweepResult> {
  // Without a provider there is nothing to send. Do not claim: mail may be
  // configured later and those requests should still escalate then.
  if (!isOutboundEmailConfigured()) return { status: "mail-not-configured" };
  const now = input.now ?? new Date();

  const products = await prisma.product.findMany({
    where: { escalationEnabled: true, archivedAt: null },
    select: { id: true, name: true, workspaceId: true, escalationAfterMinutes: true },
  });
  const adminsByWorkspace = new Map<string, string[]>();
  let escalated = 0;
  let failed = 0;
  let skipped = 0;

  for (const product of products) {
    const cutoff = new Date(now.getTime() - product.escalationAfterMinutes * 60_000);
    const candidates = await prisma.conversation.findMany({
      where: {
        ...unansweredWhere(product.id, cutoff),
        createdAt: { lte: cutoff, gt: new Date(cutoff.getTime() - OVERDUE_WINDOW_MS) },
      },
      orderBy: { createdAt: "asc" },
      take: BATCH_PER_PRODUCT,
      select: {
        id: true,
        channel: true,
        subject: true,
        createdAt: true,
        contact: { select: { name: true, email: true } },
        messages: {
          where: { kind: "CUSTOMER" },
          orderBy: { createdAt: "asc" },
          select: { body: true, createdAt: true },
        },
      },
    });
    if (candidates.length === 0) continue;

    let admins = adminsByWorkspace.get(product.workspaceId);
    if (!admins) {
      const memberships = await prisma.membership.findMany({
        where: { workspaceId: product.workspaceId, role: "ADMIN" },
        select: { user: { select: { email: true } } },
      });
      admins = memberships.map((m) => m.user.email);
      adminsByWorkspace.set(product.workspaceId, admins);
    }
    if (admins.length === 0) continue;

    for (const candidate of candidates) {
      // The claim: only one caller can flip escalatedAt, and only while the
      // Conversation is still unanswered at this instant.
      const claim = await prisma.conversation.updateMany({
        where: { id: candidate.id, workspaceId: product.workspaceId, ...unansweredWhere(product.id, cutoff) },
        data: { escalatedAt: now },
      });
      if (claim.count === 0) {
        skipped += 1;
        continue;
      }

      const mail = escalationEmail(
        {
          id: candidate.id,
          channel: candidate.channel,
          subject: candidate.subject,
          createdAt: candidate.createdAt,
          productName: product.name,
          contact: candidate.contact,
          messages: candidate.messages,
        },
        now,
      );
      let delivered = 0;
      for (const to of admins) {
        const result = await sendSystemEmail({ to, ...mail });
        if (result.ok && result.delivered) delivered += 1;
        else if (!result.ok) console.error(`escalation email to ${to} failed: ${result.error}`);
      }
      if (delivered > 0) {
        escalated += 1;
      } else {
        // Nobody got it: release the claim so the next sweep retries.
        failed += 1;
        await prisma.conversation
          .updateMany({ where: { id: candidate.id, escalatedAt: now }, data: { escalatedAt: null } })
          .catch((error: unknown) => console.error("failed to release escalation claim:", error));
      }
    }
  }
  return { status: "ok", escalated, failed, skipped };
}

const globalForSweep = globalThis as unknown as {
  __supportsealSweepChain?: Promise<unknown>;
  __supportsealLastSweepAt?: number;
};

function runSweepInBackground(): void {
  // Serialised: a sweep requested while one runs starts after it, so a
  // deadline that passed mid-sweep is never missed.
  const previous = globalForSweep.__supportsealSweepChain ?? Promise.resolve();
  globalForSweep.__supportsealLastSweepAt = Date.now();
  globalForSweep.__supportsealSweepChain = previous
    .then(() => sweepEscalations())
    .catch((error: unknown) => console.error("escalation sweep failed:", error));
}

/**
 * Lazy sweep for intake and inbox paths: at most one per minute per process,
 * fire-and-forget, never blocks or fails the request.
 */
export function sweepEscalationsLazily(): void {
  const last = globalForSweep.__supportsealLastSweepAt ?? 0;
  if (Date.now() - last < LAZY_SWEEP_INTERVAL_MS) return;
  runSweepInBackground();
}

const armed = new Set<string>();

/**
 * Best-effort in-process timer armed when a customer message lands on an
 * unanswered Conversation, so an idle self-hosted server still escalates on
 * time. One timer per Conversation; lost on restart (the lazy sweep and the
 * cron endpoint cover that); unref'd so it never holds the process open.
 */
export function armEscalationTimer(conversationId: string, dueAt: Date): void {
  if (armed.has(conversationId) || !isOutboundEmailConfigured()) return;
  armed.add(conversationId);
  const delay = Math.max(0, dueAt.getTime() - Date.now()) + 1_000;
  setTimeout(() => {
    armed.delete(conversationId);
    runSweepInBackground();
  }, delay).unref?.();
}
