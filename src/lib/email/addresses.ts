import { appConfig } from "@/lib/config";

/**
 * Instance-level mail addresses, split out of outbound.ts so the mail-loop
 * guard (loop-guard.ts) and the outbound sender can both use them without an
 * import cycle.
 */
export function inboundDomain(): string {
  return process.env.INBOUND_EMAIL_DOMAIN?.trim() || new URL(appConfig.url).hostname;
}

export function managedSender(): string {
  const local = process.env.OUTBOUND_EMAIL_LOCAL?.trim() || "no-reply";
  return `${local}@${inboundDomain()}`;
}
