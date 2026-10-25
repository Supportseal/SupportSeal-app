import { createHmac } from "node:crypto";

import { prisma } from "@/lib/prisma";
import type { WorkspaceContext } from "@/lib/workspace";

/**
 * Onboarding state, derived server-side from real data so it stays true
 * across devices and teammates (docs/design/onboarding.md).
 */
export type WizardStep = 1 | 2 | 3 | 4;

export type WizardState = {
  step: WizardStep;
  workspaceName: string | null;
  product: { id: string; name: string; primaryColor: string; widgetPublicKey: string } | null;
  hasDomains: boolean;
};

export function resolveWizardState(
  ctx: WorkspaceContext | null,
  product: WizardState["product"],
  hasDomains: boolean,
): WizardState {
  if (!ctx) {
    return { step: 1, workspaceName: null, product: null, hasDomains: false };
  }
  if (!product) {
    return { step: 2, workspaceName: ctx.workspace.name, product: null, hasDomains: false };
  }
  if (!hasDomains) {
    return { step: 3, workspaceName: ctx.workspace.name, product, hasDomains: false };
  }
  return { step: 4, workspaceName: ctx.workspace.name, product, hasDomains: true };
}

export type ChecklistItem = {
  id: string;
  title: string;
  hint: string;
  actionLabel: string;
  actionHref: string;
  required: boolean;
  done: boolean;
};

export type ChecklistState = {
  items: ChecklistItem[];
  doneCount: number;
  total: number;
};

/** The six "Get set up" items, each derived from real data. */
export async function computeChecklist(workspaceId: string): Promise<ChecklistState> {
  const [
    firstConversation,
    firstAgentReply,
    firstInboundEmail,
    productCount,
    inviteCount,
    memberCount,
    firstActiveProduct,
    firstWidgetLoad,
  ] =
    await Promise.all([
      prisma.conversation.findFirst({ where: { workspaceId }, select: { id: true } }),
      prisma.message.findFirst({
        where: { kind: "AGENT", conversation: { workspaceId } },
        select: { id: true },
      }),
      prisma.emailDelivery.findFirst({
        where: { workspaceId, direction: "INBOUND", status: "RECEIVED" },
        select: { id: true },
      }),
      prisma.product.count({ where: { workspaceId } }),
      prisma.invite.count({ where: { workspaceId } }),
      prisma.membership.count({ where: { workspaceId } }),
      prisma.product.findFirst({
        where: { workspaceId, archivedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
      // Installation signal (issue #192): the widget config was loaded from
      // an allowed host. Hosted test-page loads are never recorded.
      prisma.widgetHostSignal.findFirst({
        where: { outcome: "LOADED", product: { workspaceId, archivedAt: null } },
        select: { id: true },
      }),
    ]);

  const tested = Boolean(firstConversation);
  const items: ChecklistItem[] = [
    {
      id: "install",
      title: "Install the widget",
      hint: "Copy the snippet onto your site.",
      actionLabel: "Show snippet",
      actionHref: "/settings/products",
      // Done when the widget demonstrably ran: a config request arrived
      // from an allowed host (the installation signal, issue #192) or the
      // first conversation arrived (docs/design/onboarding.md item 1: "a
      // widget config request arrives from an allowed origin (or item 2
      // completes)"). A domain row alone proves nothing: the domain step is
      // skippable and the hosted test page needs no allowlist entry, so
      // keying this on domains left the checklist stuck at 5/6.
      required: true,
      done: tested || Boolean(firstWidgetLoad),
    },
    {
      id: "test-message",
      title: "Send a test message",
      hint: "See a chat appear in your inbox.",
      actionLabel: "Open test page",
      actionHref: "/onboarding",
      required: true,
      done: tested,
    },
    {
      id: "reply",
      title: "Reply from your inbox",
      hint: "Answer the test chat like a customer would receive.",
      actionLabel: "Open inbox",
      actionHref: "/inbox",
      required: false,
      done: Boolean(firstAgentReply),
    },
    {
      id: "email",
      title: "Set up support email",
      hint: "Forward your support address to the Product's inbound address and receive the first email.",
      actionLabel: "Product settings → Email",
      actionHref: firstActiveProduct
        ? `/settings/products/${firstActiveProduct.id}?tab=email`
        : "/settings/products",
      required: false,
      done: Boolean(firstInboundEmail),
    },
    {
      id: "second-product",
      title: "Add your second Product",
      hint: "Both appear in the same inbox.",
      actionLabel: "New Product",
      actionHref: "/settings/products",
      required: false,
      done: productCount >= 2,
    },
    {
      id: "invite",
      title: "Invite a teammate",
      hint: "Bring an agent into the Workspace.",
      actionLabel: "Settings → Team",
      actionHref: "/settings/team",
      // A joined teammate also counts: invites can be revoked, and members
      // can arrive without a surviving invite row.
      required: false,
      done: inviteCount > 0 || memberCount > 1,
    },
  ];
  return {
    items,
    doneCount: items.filter((item) => item.done).length,
    total: items.length,
  };
}

// --- Widget test tokens (design D8) ---------------------------------------
// Signed, single-Product, 30-minute tokens let the SupportSeal-hosted test
// page load the real widget without an allowlist entry. The token grants
// nothing beyond a normal visitor session for that Product.

const TEST_TOKEN_TTL_MS = 30 * 60 * 1000;

function testTokenSecret(): string | null {
  const secret = process.env.BETTER_AUTH_SECRET?.trim() || process.env.INBOUND_WEBHOOK_SECRET?.trim();
  // Never fall back to a known constant: without a configured secret, test
  // tokens are disabled entirely (issue + verify both refuse).
  return secret || null;
}

export function issueWidgetTestToken(productId: string): { token: string; expiresAt: Date } {
  const secret = testTokenSecret();
  if (!secret) {
    // No signing secret configured: the wizard shows the snippet instead of
    // the live test page.
    return { token: "", expiresAt: new Date(0) };
  }
  const expiresAt = new Date(Date.now() + TEST_TOKEN_TTL_MS);
  const payload = `${productId}|${expiresAt.getTime()}`;
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return { token: `${Buffer.from(payload).toString("base64url")}.${mac}`, expiresAt };
}

export function verifyWidgetTestToken(token: string | null | undefined, productId: string): boolean {
  const secret = testTokenSecret();
  if (!token || !secret) return false;
  const [payloadPart, mac] = token.split(".");
  if (!payloadPart || !mac) return false;
  let payload: string;
  try {
    payload = Buffer.from(payloadPart, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (expected.length !== mac.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  if (diff !== 0) return false;
  const [tokenProduct, expiry] = payload.split("|");
  return tokenProduct === productId && Number(expiry) > Date.now();
}
