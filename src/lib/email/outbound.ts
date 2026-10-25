import nodemailer, { type Transporter } from "nodemailer";

import { prisma } from "@/lib/prisma";
import { siteConfig } from "@/config/site";
import { formatTicketRef, TICKET_PREFIX } from "@/lib/ticket";
import { sendgridTransport } from "@/lib/email/providers/sendgrid";
import { inboundDomain, managedSender } from "@/lib/email/addresses";
import { outboundBlockReason, stampHeaders } from "@/lib/email/loop-guard";

export { inboundDomain, managedSender };

/**
 * Outbound email (ADR-0004, FR-EMAIL-02/03). Replies go out via the managed
 * sender "{Product} Support <no-reply@…>" with a Reply-To that routes back to
 * the conversation's reply token, so customers stay in the thread. Delivery
 * is provider-neutral: SendGrid (SENDGRID_API_KEY, the hosted provider)
 * takes precedence, then SMTP via SMTP_URL (self-hosters bring their own
 * provider); with neither, every send is recorded but not delivered (dev
 * mode). Self-hosted mode never requires SendGrid.
 */

/**
 * Provider-neutral outbound payload: whatever a provider needs to deliver a
 * mail, expressed without provider concepts (ADR-0004 boundary).
 */
export type OutboundPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Optional styled alternative to `text`; sent as multipart/alternative. */
  html?: string;
  headers: Record<string, string>;
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
};

/** A provider transport behind the outbound boundary (SendGrid, SMTP, …). */
export type OutboundTransport = {
  send(payload: OutboundPayload): Promise<{ messageId: string | null }>;
};
export type OutboundMessage = {
  to: string;
  subject: string;
  text: string;
  replyToken: string | null;
  productName: string;
  inReplyToHeader: string | null;
  referencesHeader: string | null;
  attachments?: OutboundPayload["attachments"];
};

function joinReason(a?: string, b?: string): string | undefined {
  return [a, b].filter(Boolean).join("; ") || undefined;
}

/**
 * Sanitise a display name for a quoted RFC 5322 phrase. Address-structural
 * characters (quotes, angle brackets, commas, semicolons) are removed so the
 * value can never break out of the quoted phrase regardless of how any
 * intermediary parses it (From-header injection).
 */
function escapeDisplayName(name: string): string {
  // Allowlist: keep only characters that cannot form an address or break
  // the quoted phrase; everything else (including @) becomes a space.
  return (
    name
      .replace(/[^a-zA-Z0-9 .\-'&()\/+#!?*]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 60) || "Support"
  );
}

const globalForTransport = globalThis as unknown as {
  __supportsealTransport?: Transporter;
  __supportsealSmtpTransport?: Transporter;
};

/** Adapt a nodemailer transport to the provider-neutral send seam. */
function nodemailerTransport(transport: Transporter): OutboundTransport {
  return {
    send: async (payload) => {
      const info = await transport.sendMail({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        ...(payload.html ? { html: payload.html } : {}),
        headers: payload.headers,
        ...(payload.attachments && payload.attachments.length > 0
          ? { attachments: payload.attachments }
          : {}),
      });
      return { messageId: info.messageId ?? null };
    },
  };
}

function getTransport(): OutboundTransport | null {
  // Test-injected transport wins; then SendGrid (hosted provider); then SMTP.
  if (globalForTransport.__supportsealTransport) {
    return nodemailerTransport(globalForTransport.__supportsealTransport);
  }
  const sendgrid = sendgridTransport();
  if (sendgrid) return sendgrid;
  const smtpUrl = process.env.SMTP_URL?.trim();
  if (!smtpUrl) return null;
  globalForTransport.__supportsealSmtpTransport ??= nodemailer.createTransport(smtpUrl);
  return nodemailerTransport(globalForTransport.__supportsealSmtpTransport);
}

/** True when a real provider (SendGrid, SMTP or a test transport) can deliver mail. */
export function isOutboundEmailConfigured(): boolean {
  return getTransport() !== null;
}

/** Test seam: inject a transport (or null to fall back to env provider config). */
export function setTransportForTest(transport: Transporter | null): void {
  globalForTransport.__supportsealTransport = transport ?? undefined;
}

export type SendResult =
  | { ok: true; providerMessageId: string | null; delivered: boolean }
  | { ok: false; error: string };

export async function sendReplyEmail(input: {
  workspaceId: string;
  productId: string;
  conversationId: string;
  agentMessageId: string;
  message: OutboundMessage;
  note?: string;
}): Promise<SendResult> {
  // Idempotency: one outbound delivery per agent message.
  const alreadySent = await prisma.emailDelivery.findUnique({
    where: { agentMessageId: input.agentMessageId },
  });
  if (alreadySent?.status === "SENT") {
    return { ok: true, providerMessageId: alreadySent.providerMessageId, delivered: true };
  }
  // Mail-loop guard (outbound): a Product's own support/forwarding address
  // forwards straight back into its inbox, so it is never a send target.
  const product = await prisma.product.findFirst({
    where: { id: input.productId, workspaceId: input.workspaceId },
    select: { supportEmail: true, inboundEmail: true },
  });
  const blocked = outboundBlockReason(input.message.to, product ?? {});
  if (blocked) {
    await recordDelivery(input, null, "FAILED", joinReason(blocked, input.note), input.message.to).catch(() => undefined);
    return { ok: false, error: blocked };
  }
  const sender = `"${escapeDisplayName(`${input.message.productName} Support`)}" <${managedSender()}>`;
  const headers: Record<string, string> = { ...stampHeaders() };
  if (input.message.replyToken) {
    headers["Reply-To"] = `reply+${input.message.replyToken}@${inboundDomain()}`;
  }
  if (input.message.inReplyToHeader) headers["In-Reply-To"] = input.message.inReplyToHeader;
  if (input.message.referencesHeader) headers["References"] = input.message.referencesHeader;

  const transport = getTransport();
  if (!transport) {
    // Dev / no-provider mode: record the send so the flow is auditable.
    await recordDelivery(input, null, "SENT", joinReason("no email provider configured — recorded only", input.note));
    return { ok: true, providerMessageId: null, delivered: false };
  }

  try {
    const { messageId } = await transport.send({
      from: sender,
      to: input.message.to,
      subject: input.message.subject,
      text: input.message.text,
      headers,
      attachments: input.message.attachments,
    });
    try {
      await recordDelivery(input, messageId, "SENT", input.note, input.message.to);
    } catch {
      // The customer already has the mail; never report this as FAILED.
    }
    return { ok: true, providerMessageId: messageId, delivered: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "send failed";
    await recordDelivery(input, null, "FAILED", reason, input.message.to).catch(() => undefined);
    return { ok: false, error: reason };
  }
}

async function recordDelivery(
  input: { workspaceId: string; productId: string; conversationId: string; agentMessageId: string },
  providerMessageId: string | null,
  status: "SENT" | "FAILED",
  reason?: string,
  toAddress?: string,
): Promise<void> {
  await prisma.emailDelivery.upsert({
    where: { agentMessageId: input.agentMessageId },
    create: {
      workspaceId: input.workspaceId,
      productId: input.productId,
      conversationId: input.conversationId,
      direction: "OUTBOUND",
      status,
      providerMessageId,
      toAddress: toAddress ?? null,
      reason: reason ?? null,
      agentMessageId: input.agentMessageId,
    },
    update: { status, providerMessageId, reason: reason ?? null },
  });
}

/** Rejection bounce for undeliverable inbound mail (FR-EMAIL-03). */
export async function sendBounce(input: {
  productId: string | null;
  toAddress: string;
  originalSubject: string | null;
  reason: string;
}): Promise<void> {
  const transport = getTransport();
  if (!transport) return; // record-only: nothing to send
  await transport.send({
    from: `Mail Delivery Subsystem <${managedSender()}>`,
    to: input.toAddress,
    subject: `Undeliverable: ${input.originalSubject ?? "your message"}`,
    text: `Your message could not be delivered: ${input.reason}.`,
    headers: {
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
      ...stampHeaders(),
    },
  });
}

/**
 * Transactional system email not tied to a Conversation (e.g. Workspace
 * admin allowance notices, end-user auth mail such as password resets).
 * Not a customer reply, so it has no EmailDelivery row; callers keep
 * their own audit record. Delivered through the same provider boundary
 * (SendGrid API or SMTP); record-only when no provider is configured.
 */
export async function sendSystemEmail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ ok: true; delivered: boolean } | { ok: false; delivered: false; error: string }> {
  const transport = getTransport();
  if (!transport) return { ok: true, delivered: false };
  try {
    await transport.send({
      from: `"${escapeDisplayName(siteConfig.name)}" <${managedSender()}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      headers: {
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "All",
        ...stampHeaders(),
      },
    });
    return { ok: true, delivered: true };
  } catch (error) {
    return { ok: false, delivered: false, error: error instanceof Error ? error.message : "send failed" };
  }
}

const LEADING_REPLY_NOISE = new RegExp(`^(?:\\s*(?:re:|\\[${TICKET_PREFIX}-\\d+\\]))+\\s*`, "iu");

/**
 * Outbound subject for a conversation: `Re: [SS-123] <subject>`. The ticket
 * reference is for the customer to quote (issue #141); it is display only —
 * inbound threading never reads it (FR-EMAIL-01). Any `Re:` / `[SS-n]`
 * already on the stored subject is normalised so replies never stack
 * `Re: Re: [SS-123] [SS-123]`.
 */
export function replySubject(
  subject: string | null,
  productName: string,
  ticketNumber: number,
): string {
  const base =
    (subject ?? "")
      .replace(LEADING_REPLY_NOISE, "")
      .trim() || `${productName} support`;
  return `Re: [${formatTicketRef(ticketNumber)}] ${base}`;
}
