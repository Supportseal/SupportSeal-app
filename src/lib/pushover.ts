import { brand } from "@/lib/brand";

/**
 * Owner push notifications through Pushover, the same way the maintainer's
 * other apps announce signups. Optional: without PUSHOVER_API_TOKEN and
 * PUSHOVER_USER_KEY nothing is sent (self-hosted installs never need it).
 */

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const MAX_TITLE = 250;
const MAX_MESSAGE = 1024;
const TIMEOUT_MS = 5000;
const OWNER_TIME_ZONE = "Australia/Perth";

export type PushoverMessage = {
  title: string;
  message: string;
  sound?: string;
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** "jane.doe@acme.io" → "j*******@acme.io": enough to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "****";
  const local = email.slice(0, at);
  return `${local[0]}${"*".repeat(Math.min(Math.max(local.length - 1, 1), 7))}${email.slice(at)}`;
}

function ownerTimestamp(): string {
  return new Date().toLocaleString("en-AU", { timeZone: OWNER_TIME_ZONE });
}

export function isPushoverConfigured(): boolean {
  return Boolean(process.env.PUSHOVER_API_TOKEN?.trim() && process.env.PUSHOVER_USER_KEY?.trim());
}

/**
 * Sends one notification. Returns false when Pushover is not configured.
 * A configured send that fails is logged, so a broken token shows up in the
 * server log instead of signups going quietly unannounced.
 */
export async function sendPushover(input: PushoverMessage): Promise<boolean> {
  const token = process.env.PUSHOVER_API_TOKEN?.trim();
  const user = process.env.PUSHOVER_USER_KEY?.trim();
  if (!token || !user) return false;

  const body = new URLSearchParams({
    token,
    user,
    title: truncate(input.title, MAX_TITLE),
    message: truncate(input.message, MAX_MESSAGE),
    ...(input.sound ? { sound: input.sound } : {}),
  });
  try {
    const response = await fetch(PUSHOVER_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(`[pushover] "${input.title}" rejected: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[pushover] "${input.title}" failed:`, error);
    return false;
  }
}

/** Fire and forget: a notification must never slow down or fail a signup. */
function notifyOwner(input: PushoverMessage): void {
  if (!isPushoverConfigured()) return;
  void sendPushover(input);
}

export type SignupMethod = "email" | "github" | "google";

const METHOD_LABEL: Record<SignupMethod, string> = {
  email: "Email and password",
  github: "GitHub",
  google: "Google",
};

export function notifyOwnerAccountCreated(input: { email: string; method: SignupMethod }): void {
  notifyOwner({
    title: `New account on ${brand.name}`,
    message: [
      `Email: ${maskEmail(input.email)}`,
      `Signed up with: ${METHOD_LABEL[input.method]}`,
      `Time: ${ownerTimestamp()}`,
    ].join("\n"),
    sound: "magic",
  });
}

export function notifyOwnerWorkspaceCreated(input: {
  workspaceName: string;
  ownerEmail: string;
  planName: string;
}): void {
  notifyOwner({
    title: `New ${input.planName} Workspace on ${brand.name}`,
    message: [
      `Workspace: ${input.workspaceName}`,
      `Owner: ${maskEmail(input.ownerEmail)}`,
      `Plan: ${input.planName}`,
      `Time: ${ownerTimestamp()}`,
    ].join("\n"),
    sound: "magic",
  });
}
