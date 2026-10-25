import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { sendBounce } from "@/lib/email/outbound";
import { htmlToText } from "@/lib/email/html-text";
import { LOOP_HEADER, detectInboundLoop, isOwnAddress, type ProductAddresses } from "@/lib/email/loop-guard";
import { inboundBodyText } from "@/lib/email/quotes";
import { addCustomerMessage, upsertContact } from "@/lib/conversations";
import { notifyAllowanceInBackground } from "@/lib/usage-notifications";
import { allocateTicketNumber, isTicketNumberCollision } from "@/lib/ticket";
import {
  AttachmentError,
  storeAttachment,
  validateAttachment,
} from "@/lib/attachments";

/**
 * Inbound email (ADR-0004, FR-EMAIL-01/03). The webhook accepts either a
 * SendGrid Inbound Parse multipart post or the same fields as JSON (the
 * documented self-host bridge shape). Everything here treats input as
 * untrusted: addresses/headers are parsed defensively, HTML is never used as
 * the message body (plain text only — safe by construction; the raw HTML is
 * kept in the delivery record for later sanitised display), threading relies
 * on validated headers or the conversation reply token, never the subject.
 */
export const INBOUND_AUTH_HEADER = "x-supportseal-inbound-secret";

export function inboundSecret(): string | undefined {
  return process.env.INBOUND_WEBHOOK_SECRET?.trim() || undefined;
}

/** Constant-time-ish compare for the webhook secret. */
export function secretMatches(candidate: string | null | undefined): boolean {
  const expected = inboundSecret();
  if (!expected || !candidate) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(a, b);
}

/**
 * Credential candidates from an `Authorization: Basic …` header. Inbound
 * providers (SendGrid Inbound Parse) cannot set custom headers or sign
 * webhooks; the protection is a secret embedded in the webhook URL, either
 * as `?secret=` or as Basic-Auth userinfo, so either side of the credential
 * may carry the shared secret. The auth-scheme is matched case-insensitively
 * per RFC 7235.
 */
export function basicAuthSecretCandidates(header: string | null | undefined): string[] {
  const match = /^basic\s+(.+)$/iu.exec(header?.trim() ?? "");
  if (!match) return [];
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon >= 0 ? [decoded.slice(0, colon), decoded.slice(colon + 1)] : [decoded];
}

export type InboundAttachmentInput = {
  filename: string;
  contentType: string;
  data: Uint8Array;
};

export type InboundEmail = {
  from: { email: string; name: string | null };
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  headers: {
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    autoSubmitted: string | null;
    precedence: string | null;
    xAutoreply: string | null;
    /** Raw Reply-To header; see `resolveContactSender`. */
    replyTo: string | null;
    /** Our own stamp (loop-guard.ts); optional so bridges/fixtures can omit it. */
    xSupportSeal?: string | null;
  };
  attachments: InboundAttachmentInput[];
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Extract the first address from a header value like `Name <a@b.c>`. */
export function parseAddress(raw: string | null | undefined): { email: string; name: string | null } | null {
  if (!raw) return null;
  const value = raw.trim();
  const bracket = /<([^<>]+)>/u.exec(value);
  const candidate = (bracket ? bracket[1] : value).trim();
  // Lowercase only the domain: local parts (incl. reply tokens) are
  // case-sensitive and must keep their stored casing.
  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1) return null;
  const email = `${candidate.slice(0, at)}@${candidate.slice(at + 1).toLowerCase()}`;
  if (!EMAIL_PATTERN.test(email)) return null;
  const name = bracket ? value.slice(0, bracket.index).trim().replace(/^"|"$/gu, "") : null;
  return { email, name: name || null };
}

/** Split an address list on commas, ignoring commas inside quoted strings. */
function splitAddressList(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of raw) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

export function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return splitAddressList(raw)
    .map((part) => parseAddress(part)?.email)
    .filter((email): email is string => Boolean(email));
}

export function splitMessageIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // Keep the angle brackets: stored Message-Ids include them.
  return raw.split(/\s+/u).map((token) => token.trim()).filter(Boolean);
}

/**
 * Parse a raw header block (folded RFC 822 text) into name → value. Folded
 * continuation lines are unfolded; a repeated name keeps its last value.
 */
export function parseRawHeaders(value: string): Record<string, string> {
  const map: Record<string, string> = {};
  let lastName: string | null = null;
  for (const line of value.trim().split(/\r?\n/u)) {
    if (/^\s/u.test(line) && lastName) {
      map[lastName] = `${map[lastName]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      lastName = line.slice(0, colon).trim();
      map[lastName] = line.slice(colon + 1).trim();
    }
  }
  return map;
}

/** Copy a record with lowercased keys (header lookup is case-insensitive). */
export function lowercaseKeys<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
}

/**
 * Threading/auto-response headers from a webhook body. Headers arrive under
 * "headers" as an object, a JSON string or a raw RFC 822 string (SendGrid),
 * or as top-level fields (bridges). Names are matched case-insensitively.
 */
export function headersFromBody(body: Record<string, unknown>): InboundEmail["headers"] {
  let raw: Record<string, unknown> = {};
  if (body.headers && typeof body.headers === "string") {
    const trimmed = body.headers.trim();
    if (trimmed.startsWith("{")) {
      try {
        raw = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        raw = {};
      }
    } else {
      raw = parseRawHeaders(trimmed);
    }
  } else if (body.headers && typeof body.headers === "object") {
    raw = body.headers as Record<string, unknown>;
  }
  const normalized = lowercaseKeys(raw);
  const get = (name: string) => {
    const value = normalized[name.toLowerCase()] ?? body[name];
    return typeof value === "string" && value.trim() ? value : null;
  };
  return {
    messageId: get("Message-ID"),
    inReplyTo: get("In-Reply-To"),
    references: splitMessageIds(get("References")),
    autoSubmitted: get("Auto-Submitted"),
    precedence: get("Precedence"),
    xAutoreply: get("X-Autoreply"),
    replyTo: get("Reply-To"),
    xSupportSeal: get(LOOP_HEADER),
  };
}

// Re-exported for existing importers; the implementation lives in
// html-text.ts (quotes.ts consumes it and must not import inbound.ts back).
export { htmlToText };

/**
 * The address the customer should be attributed to. Mail relayed through
 * contact forms or forwarders arrives From the relay but carries the real
 * customer in Reply-To, so a valid Reply-To wins (the first valid entry of a
 * list). It is ignored when it points back at one of the recipients, which
 * would make a mail loop of our own inbound address. From stays the audit
 * address (delivery records, bounces, the derived Message-ID).
 */
export function resolveContactSender(email: InboundEmail): { email: string; name: string | null } {
  const recipients = new Set(email.to.map((address) => address.toLowerCase()));
  for (const part of email.headers.replyTo ? splitAddressList(email.headers.replyTo) : []) {
    const replyTo = parseAddress(part);
    if (replyTo && !recipients.has(replyTo.email.toLowerCase())) return replyTo;
  }
  return email.from;
}

export class InboundRejectError extends Error {
  constructor(
    public code:
      | "unauthorized"
      | "bad_request"
      | "unknown_address"
      | "archived_product"
      | "duplicate"
      | "invalid_sender",
    message: string,
  ) {
    super(message);
  }
}

/** Product inbound address local part: product_<random>@<inbound domain>. */
export function generateInboundLocalPart(): string {
  return `product_${randomBytes(9).toString("base64url").toLowerCase()}`;
}

export function replyTokenFor(): string {
  // Lowercase: some mail hops lowercase local parts; the token must
  // survive that (finding: case-sensitive continuation).
  return randomBytes(16).toString("base64url").toLowerCase();
}

async function findProductByRecipient(recipients: string[]) {
  for (const recipient of recipients) {
    const [localPart, domain] = recipient.split("@");
    if (!localPart || !domain) continue;
    const product = await prisma.product.findFirst({
      // Only a verified address routes: platform-generated addresses are
      // stamped at allocation, anything else needs proof first (issue #169).
      where: {
        inboundEmail: { equals: recipient, mode: "insensitive" },
        inboundEmailVerified: { not: null },
      },
      include: { workspace: { select: { id: true } } },
    });
    if (product) return { product, matchedAddress: recipient, kind: "product" as const };
    // Reply tokens: reply+<token>@<domain> continues a conversation.
    const replyMatch = /^reply\+([a-z0-9_-]+)$/iu.exec(localPart);
    if (replyMatch) {
      // Case-insensitive compare, never a lowercased lookup: some mail
      // hops lowercase local parts, and conversations created before the
      // generator lowercased tokens may hold mixed-case values —
      // normalising the query would break those forever.
      const conversation = await prisma.conversation.findFirst({
        where: { emailReplyToken: { equals: replyMatch[1], mode: "insensitive" } },
        include: { product: { include: { workspace: { select: { id: true } } } } },
      });
      if (conversation) {
        return {
          product: conversation.product,
          matchedAddress: recipient,
          kind: "reply" as const,
          conversation,
        };
      }
    }
    // A DNS-verified custom mail domain is dedicated to one Product: every
    // address on it routes there (docs/design/mail-setup.md).
    const mailDomain = await prisma.productMailDomain.findFirst({
      where: { domain: domain.toLowerCase(), verifiedAt: { not: null } },
      include: { product: { include: { workspace: { select: { id: true } } } } },
    });
    if (mailDomain) return { product: mailDomain.product, matchedAddress: recipient, kind: "product" as const };
  }
  return null;
}

async function findConversationByHeaders(email: InboundEmail, productId: string, workspaceId: string) {
  const candidates = [
    ...splitMessageIds(email.headers.inReplyTo ?? null),
    ...email.headers.references,
  ].map((id) => id.trim());
  for (const candidate of candidates) {
    if (!candidate) continue;
    const byConversationHeader = await prisma.conversation.findFirst({
      where: { productId, emailMessageId: candidate },
    });
    if (byConversationHeader) return byConversationHeader;
    const byDelivery = await prisma.emailDelivery.findFirst({
      where: {
        direction: "OUTBOUND",
        providerMessageId: candidate,
        workspaceId,
      },
    });
    if (byDelivery?.conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: byDelivery.conversationId, productId },
      });
      if (conversation) return conversation;
    }
  }
  return null;
}

async function recordBounce(
  productId: string | null,
  toAddress: string,
  subject: string | null,
  reason: string,
  productAddresses: ProductAddresses = {},
): Promise<void> {
  // Never bounce bounces/system senders (mail loops, FR-EMAIL-03).
  const local = toAddress.split("@")[0]?.toLowerCase() ?? "";
  // Never bounce to this instance's own sender or a Product's own address
  // either: the bounce would be re-ingested and bounced again.
  if (isOwnAddress(toAddress, productAddresses)) return;
  if (
    local.startsWith("mailer-daemon") ||
    local.startsWith("postmaster") ||
    local.startsWith("no-reply") ||
    local.startsWith("noreply")
  ) {
    return;
  }
  await sendBounce({ productId, toAddress, originalSubject: subject, reason }).catch(() => undefined);
}

function bodyPreview(email: InboundEmail): string {
  return (email.text?.trim() || (email.html ? htmlToText(email.html) : "")).slice(0, 500);
}

export type InboundResult =
  | { outcome: "created"; conversationId: string; duplicate: false }
  | { outcome: "duplicate"; conversationId: string | null }
  | { outcome: "ignored"; reason: string }
  | { outcome: "rejected"; reason: string; bounce: boolean };

/**
 * Deterministic storage key for an inbound attachment, so a provider retry
 * reuses what a crashed attempt already stored instead of duplicating the
 * blob and its row. Keyed by product + Message-ID + position + content.
 */
export function inboundAttachmentStorageKey(input: {
  productId: string;
  providerMessageId: string;
  index: number;
  data: Uint8Array;
}): string {
  return createHash("sha256")
    .update(`${input.productId}|${input.providerMessageId}|${input.index}|`)
    .update(input.data)
    .digest("hex");
}

/**
 * Completion-marker hook for `addCustomerMessage` (issue #102): commits the
 * delivery's `messageId` atomically with the Message insert. Throws
 * `duplicate` when no unmarked row remains — a concurrent worker completed
 * this email between our read and this transaction — so the insert rolls
 * back instead of committing a second message.
 */
export function markInboundDeliveryComplete(input: {
  productId: string;
  providerMessageId: string;
  conversationId: string;
}): (tx: Prisma.TransactionClient, messageId: string) => Promise<void> {
  const { productId, providerMessageId, conversationId } = input;
  return async (tx, messageId) => {
    const marked = await tx.emailDelivery.updateMany({
      where: {
        direction: "INBOUND",
        productId,
        providerMessageId,
        messageId: null,
      },
      data: { messageId, conversationId },
    });
    if (marked.count === 0) {
      throw new InboundRejectError("duplicate", "Already processed.");
    }
  };
}

/**
 * Process one normalised inbound email against a Product. Idempotent by
 * Message-ID, threads by headers/reply token, never by subject.
 *
 * Crash recovery (issue #102): the RECEIVED delivery row only counts as
 * complete once its `messageId` marker commits — in the same transaction
 * as the customer Message insert. A crashed attempt therefore leaves the
 * row unmarked and the provider retry reprocesses it, even when the reply
 * threads onto a conversation that already has earlier messages.
 */
export async function processInboundEmail(input: {
  email: InboundEmail;
}): Promise<InboundResult> {
  const { email } = input;
  const sender = email.from;
  const contactSender = resolveContactSender(email);
  if (!sender) throw new InboundRejectError("invalid_sender", "No usable From address.");

  const match = await findProductByRecipient(email.to);
  if (!match) {
    await recordBounce(null, sender.email, email.subject, "no product matches the recipient address");
    return { outcome: "rejected", reason: "no product matches the recipient address", bounce: true };
  }
  const { product } = match;
  const workspaceId = product.workspace.id;

  const processedAttachments = email.attachments.slice(0, 10);
  let providerMessageId = email.headers.messageId ?? null;
  if (!providerMessageId) {
    // No Message-ID: derive a deterministic one so provider retries stay
    // idempotent. Attachments are part of the fingerprint — two mails with
    // identical text but different files are different messages. So is the
    // resolved contact: visitors behind one form relay share From, subject
    // and (when empty) body, and differ only in Reply-To. It is folded in
    // only when it differs from From, keeping existing fingerprints stable.
    const hash = createHash("sha256")
      .update(`${sender.email}|${email.to.join(",")}|${email.subject ?? ""}|${bodyPreview(email)}`);
    if (contactSender.email !== sender.email) hash.update(`|contact:${contactSender.email}`);
    processedAttachments.forEach((attachment) => {
      hash.update(`|${attachment.filename}|${attachment.contentType}|${attachment.data.byteLength}|`);
      hash.update(attachment.data);
    });
    providerMessageId = `<sha256-${hash.digest("hex")}>`;
  }
  const existing = await prisma.emailDelivery.findUnique({
    where: {
      direction_productId_providerMessageId: {
        direction: "INBOUND",
        productId: product.id,
        providerMessageId,
      },
    },
  });
  if (existing?.messageId) {
    // Completion marker: the message insert and this marker committed
    // together, so the inbound email fully processed — ack the duplicate.
    return { outcome: "duplicate", conversationId: existing.conversationId };
  }
  // `existing` without a marker (or without a row yet) falls through: a
  // crashed prior attempt is recovered by reprocessing below.

  const recordDelivery = async (status: "RECEIVED" | "IGNORED" | "REJECTED", conversationId: string | null, reason?: string) => {
    try {
      await prisma.emailDelivery.create({
        data: {
          workspaceId,
          productId: product.id,
          conversationId,
          direction: "INBOUND",
          status,
          providerMessageId,
          fromAddress: sender.email,
          toAddress: email.to.join(", "),
          subject: email.subject?.slice(0, 250) ?? null,
          reason: reason?.slice(0, 250) ?? null,
        },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "P2002") {
        // Unique race: another worker recorded this message id first.
        throw new InboundRejectError("duplicate", "Already processed.");
      }
      throw error;
    }
  };

  // Loop / auto-response guard (docs/design/product-settings.md "Support
  // email"). Before the archived bounce: bouncing a loop would feed it.
  const loopReason = detectInboundLoop({ from: sender.email, headers: email.headers, product });
  if (loopReason) {
    await recordDelivery("IGNORED", null, loopReason);
    return { outcome: "ignored", reason: loopReason.startsWith("mail loop") ? "mail loop" : "auto-response" };
  }

  if (product.archivedAt) {
    await recordDelivery("REJECTED", null, "product archived — inbound mail is rejected (bounce)");
    await recordBounce(product.id, sender.email, email.subject, "this Product is archived", product);
    return { outcome: "rejected", reason: "product archived", bounce: true };
  }

  // Resolve the conversation: reply token first, then validated threading headers.
  let conversation =
    match.kind === "reply" ? match.conversation : await findConversationByHeaders(email, product.id, workspaceId);
  if (match.kind === "reply" && conversation) {
    // The token is a shared secret; still require the sender to be a known
    // participant (contact or visitor email) before posting as the customer.
    const known = new Set(
      [conversation.contactId ? await prisma.contact.findUnique({ where: { id: conversation.contactId }, select: { email: true } }) : null]
        .filter(Boolean)
        .map((c) => (c as { email: string | null }).email?.toLowerCase())
        .filter(Boolean) as string[],
    );
    const visitor = await prisma.chatVisitor.findFirst({
      where: { conversationId: conversation.id },
      select: { email: true },
    });
    if (visitor?.email) known.add(visitor.email.toLowerCase());
    if (!known.has(contactSender.email.toLowerCase()) && !known.has(sender.email.toLowerCase())) {
      await recordDelivery("REJECTED", null, "reply-token sender does not match conversation participants");
      return { outcome: "rejected", reason: "sender not a conversation participant", bounce: false };
    }
  }
  // Recovery: the crashed attempt's delivery points at a conversation the
  // retry can no longer resolve by threading (a crashed first mail has no
  // In-Reply-To of its own) — continue on that conversation.
  if (!conversation && existing?.conversationId) {
    conversation = await prisma.conversation.findFirst({
      where: { id: existing.conversationId, productId: product.id },
    });
  }

  // Quoted originals are stripped conservatively (issue #128): the stored
  // body is the customer's own text, not the copy of ours underneath.
  const bodyText = inboundBodyText(email).slice(0, 20_000);

  let createdConversation = false;
  if (!conversation) {
    const contact = await upsertContact({ workspaceId, email: contactSender.email, name: contactSender.name });
    // Conversation + RECEIVED delivery in one transaction: a concurrent
    // duplicate webhook loses the unique race cleanly, without orphans.
    conversation = await prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          workspaceId,
          // Allocated in this transaction: a lost duplicate-webhook race
          // rolls the counter back too, so no number is burned.
          ticketNumber: await allocateTicketNumber(tx, workspaceId),
          productId: product.id,
          contactId: contact.id,
          channel: "EMAIL",
          subject: email.subject?.slice(0, 250) ?? null,
          emailMessageId: providerMessageId,
          emailReplyToken: replyTokenFor(),
        },
      });
      await tx.emailDelivery.create({
        data: {
          workspaceId,
          productId: product.id,
          conversationId: created.id,
          direction: "INBOUND",
          status: "RECEIVED",
          providerMessageId,
          fromAddress: sender.email,
          toAddress: email.to.join(", "),
          subject: email.subject?.slice(0, 250) ?? null,
        },
      });
      return created;
    }).catch((error: { code?: string }) => {
      if (error.code === "P2002" && !isTicketNumberCollision(error)) throw new InboundRejectError("duplicate", "Already processed.");
      throw error;
    });
    createdConversation = true;
    // Hosted only, fire-and-forget: never blocks or fails intake (FR-USE-02).
    notifyAllowanceInBackground(workspaceId);
  } else if (providerMessageId && !conversation.emailMessageId) {
    // In a thread, remember the root/first inbound Message-ID for future replies.
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { emailMessageId: conversation.emailMessageId ?? providerMessageId },
    });
  }

  // First attempt for a threaded reply: claim the Message-ID up front so
  // concurrent duplicates lose the unique race. Completion is NOT this row
  // — it is the messageId marker set in the message transaction below, so
  // a crash between here and there is recoverable on retry.
  if (!createdConversation && !existing) {
    await recordDelivery("RECEIVED", conversation.id);
  }

  const attachmentIds: string[] = [];
  for (const [index, attachment] of processedAttachments.entries()) {
    try {
      const validated = validateAttachment({
        name: attachment.filename,
        type: attachment.contentType,
        data: attachment.data,
      });
      const stored = await storeAttachment({
        workspaceId,
        productId: product.id,
        conversationId: conversation.id,
        file: validated,
        // Deterministic key: a retry after a crash reuses what the first
        // attempt already stored instead of duplicating it.
        storageKey: inboundAttachmentStorageKey({
          productId: product.id,
          providerMessageId,
          index,
          data: validated.data,
        }),
      });
      attachmentIds.push(stored.id);
    } catch (error) {
      if (error instanceof AttachmentError) continue; // oversized/unsafe attachment: drop, keep the message
      throw error;
    }
  }

  const message = await addCustomerMessage({
    workspaceId,
    conversationId: conversation.id,
    body: bodyText || "(no text content)",
    source: { kind: "email", fromEmail: contactSender.email },
    attachmentIds,
    inTransaction: markInboundDeliveryComplete({
      productId: product.id,
      providerMessageId,
      conversationId: conversation.id,
    }),
  });
  if (!message.ok) throw new Error(message.error);

  void createdConversation;
  return {
    outcome: "created",
    conversationId: conversation.id,
    duplicate: false,
  };
}
