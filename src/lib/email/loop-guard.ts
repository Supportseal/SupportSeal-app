import { inboundDomain, managedSender } from "@/lib/email/addresses";

/**
 * Mail-loop guard. A customer's real support address (support@acme.com)
 * forwards into SupportSeal, so anything we send to it — or any automatic
 * mail it sends back — would come straight back in as a new Conversation.
 * Two independent layers break the cycle:
 *
 * - outbound: never send to a Product's own addresses (`isOwnAddress`);
 * - inbound: drop mail that is automatic, that we sent ourselves (stamp
 *   header or our Message-ID shape) or that comes from the Product's own
 *   addresses (`detectInboundLoop`).
 *
 * Pure functions only; callers do the I/O.
 */

/** Header stamped on every mail we send; its value is the sending instance's mail domain. */
export const LOOP_HEADER = "X-SupportSeal";

/** Headers every outbound mail carries so a returning copy is recognisable. */
export function stampHeaders(): Record<string, string> {
  return { [LOOP_HEADER]: inboundDomain().toLowerCase() };
}

/** The addresses that identify a Product's own mailbox, all lowercase. */
export type ProductAddresses = {
  supportEmail?: string | null;
  inboundEmail?: string | null;
};

const REPLY_LOCAL = /^reply\+/iu;

/**
 * True for an address that belongs to the Product or to SupportSeal itself:
 * the configured support address, the generated forwarding address, the
 * managed no-reply sender and any per-Conversation `reply+token@` address.
 */
export function isOwnAddress(address: string | null | undefined, product: ProductAddresses): boolean {
  const value = address?.trim().toLowerCase();
  if (!value) return false;
  if (value === product.supportEmail?.trim().toLowerCase()) return true;
  if (value === product.inboundEmail?.trim().toLowerCase()) return true;
  if (value === managedSender().toLowerCase()) return true;
  const at = value.lastIndexOf("@");
  return at > 0 && REPLY_LOCAL.test(value.slice(0, at)) && value.slice(at + 1) === inboundDomain().toLowerCase();
}

/** Why `to` must not receive mail from this Product, or null when it is fine. */
export function outboundBlockReason(to: string | null | undefined, product: ProductAddresses): string | null {
  return isOwnAddress(to, product)
    ? "recipient is this Product's own support/forwarding address — not sent (mail loop guard)"
    : null;
}

// Our Message-IDs are `<uuid@mail-domain>` (set in the SendGrid adapter;
// nodemailer's default has the same shape). The strict shape keeps ordinary
// mail from the same domain (e.g. staff on Exchange) from being mistaken for ours.
const UUID_LOCAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-(?:[0-9a-f]{4}-)?[0-9a-f]{12}$/iu;

function isOurMessageId(messageId: string | null | undefined): boolean {
  const match = /^<?([^<>@\s]+)@([^<>\s]+?)>?$/u.exec(messageId?.trim() ?? "");
  return match !== null && UUID_LOCAL.test(match[1]) && match[2].toLowerCase() === inboundDomain().toLowerCase();
}

/** Auto-Submitted/Precedence/X-Autoreply: RFC 3834 "do not reply" signals. */
export function isAutomaticMail(headers: {
  autoSubmitted: string | null;
  precedence: string | null;
  xAutoreply: string | null;
}): boolean {
  const auto = headers.autoSubmitted?.trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (headers.xAutoreply) return true;
  const precedence = headers.precedence?.trim().toLowerCase();
  return precedence === "bulk" || precedence === "junk" || precedence === "list" || precedence === "auto_reply";
}

/**
 * Reason an inbound mail must be dropped as a loop or auto-response, or
 * null when it is a real customer message. Order: cheapest, most certain
 * signals first. References are deliberately NOT inspected: a genuine
 * customer reply quotes our Message-IDs there, and that is how it threads.
 */
export function detectInboundLoop(input: {
  from: string;
  headers: {
    messageId: string | null;
    autoSubmitted: string | null;
    precedence: string | null;
    xAutoreply: string | null;
    xSupportSeal?: string | null;
  };
  product: ProductAddresses;
}): string | null {
  const { headers } = input;
  // The stamp's value is the sending instance's mail domain: only OUR stamp is
  // a loop. Mail from another SupportSeal instance is a genuine message.
  if (headers.xSupportSeal?.trim().toLowerCase() === inboundDomain().toLowerCase()) {
    return "mail loop: carries our X-SupportSeal stamp (sent by this SupportSeal instance)";
  }
  if (isOurMessageId(headers.messageId)) return "mail loop: Message-ID was issued by this SupportSeal instance";
  if (isAutomaticMail(headers)) return "auto-response (Auto-Submitted/Precedence/X-Autoreply)";
  if (isOwnAddress(input.from, input.product)) {
    return "mail loop: sender is this Product's own support/forwarding address";
  }
  return null;
}
