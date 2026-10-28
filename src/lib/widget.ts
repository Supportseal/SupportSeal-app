import { createHash, randomBytes } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";

import { verifyWidgetTestToken } from "@/lib/onboarding";

import { notifyConversationEvent } from "@/lib/events";

import {
  mergeDevContext,
  type VisitorIdentity,
} from "@/lib/dev-context";
import { prisma } from "@/lib/prisma";
import { isServicePaused, SERVICE_PAUSED_CODE } from "@/lib/service-pause";
import { notifyAllowanceInBackground } from "@/lib/usage-notifications";
import { allocateTicketNumber, formatTicketRef } from "@/lib/ticket";
import {
  addCustomerMessage,
  createConversationWithFirstMessage,
  getConversationDetail,
  upsertContact,
  type CustomerMessageDiagnosticsOutcome,
} from "@/lib/conversations";
import { isOwnAddress } from "@/lib/email/loop-guard";
import { normalizeSnapshot, type NormalizedSnapshot } from "@/lib/diagnostics/snapshot";

export type WidgetProduct = {
  id: string;
  name: string;
  primaryColor: string;
  widgetPublicKey: string;
  workspaceId: string;
  domains: string[];
  diagnosticsEnabledAt: Date | null;
  supportEmail: string | null;
};

export async function loadWidgetProduct(widgetKey: string): Promise<WidgetProduct | null> {
  if (!widgetKey.startsWith("pk_")) return null;
  const product = await prisma.product.findFirst({
    where: { widgetPublicKey: widgetKey, archivedAt: null },
    include: { domains: { select: { domain: true } } },
  });
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    primaryColor: product.primaryColor,
    widgetPublicKey: product.widgetPublicKey,
    workspaceId: product.workspaceId,
    domains: product.domains.map((d) => d.domain),
    diagnosticsEnabledAt: product.diagnosticsEnabledAt,
    supportEmail: product.supportEmail,
  };
}

export type FormProduct = {
  id: string;
  workspaceId: string;
  supportEmail: string | null;
  inboundEmail: string | null;
  formPublicKey: string;
};

export async function loadFormProduct(formKey: string): Promise<FormProduct | null> {
  if (!formKey.startsWith("fk_")) return null;
  const product = await prisma.product.findFirst({
    where: { formPublicKey: formKey, archivedAt: null },
    select: { id: true, workspaceId: true, supportEmail: true, inboundEmail: true },
  });
  return product && { ...product, formPublicKey: formKey };
}

/**
 * Form key transport: the `x-ss-form-key` header first (keeps the key out
 * of access logs), the `?key=` query parameter as the fallback, mirroring
 * the widget key's query transport.
 */
export function formKeyFromRequest(request: { headers: Headers; nextUrl: URL }): string {
  return (
    request.headers.get("x-ss-form-key")?.trim() ||
    request.nextUrl.searchParams.get("key")?.trim() ||
    ""
  );
}

/** Shared contact-email validation (widget email capture and form posts). */
export function normalizeContactEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  // 254 = RFC 5321 path limit, matching normalizeSupportEmail; keeps an
  // unbounded address out of contacts.email and its unique btree index.
  if (email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}

const FORM_MESSAGE_MAX = 5000;

/** Relayed by the submitting server to the person filling in the form. */
export const FORM_PAUSED_MESSAGE =
  "This team isn't taking messages through this form right now. Please contact them another way.";

/** CHAT so analytics counts form posts with other website-channel submissions. */
export async function createFormConversation(input: {
  product: FormProduct;
  email: string;
  name?: string | null;
  subject?: string | null;
  message: string;
}): Promise<
  | { ok: true; ticketRef: string }
  | { ok: false; error: string; productGone?: true; paused?: true }
> {
  if (await isServicePaused(input.product.workspaceId)) {
    return { ok: false, error: FORM_PAUSED_MESSAGE, paused: true };
  }
  const email = normalizeContactEmail(input.email);
  if (!email) return { ok: false, error: "Enter a valid email address." };
  // Mail-loop guard (review of #154): a form submitted with the Product's
  // own support/forwarding address would make replies re-ingest (see
  // setVisitorEmail and loop-guard.ts). Refuse it at the source.
  if (isOwnAddress(email, input.product)) {
    return { ok: false, error: "That is this team's own support address. Enter your own email address." };
  }
  // Reject rather than truncate (review of #167): the submitter is a server,
  // so a silently shortened message could never be noticed or relayed.
  const body = input.message.trim();
  if (!body) return { ok: false, error: "Message is empty." };
  if (body.length > FORM_MESSAGE_MAX) {
    return { ok: false, error: `Message is too long (max ${FORM_MESSAGE_MAX} characters).` };
  }
  const name = input.name?.trim().slice(0, 120) || null;
  const subject = input.subject?.trim().slice(0, 200) || null;

  const contact = await upsertContact({
    workspaceId: input.product.workspaceId,
    email,
    name,
  });
  // Conversation and first message in one transaction (review of #154): a
  // crash between separate inserts would strand an empty Conversation that
  // usage metering already counted.
  const conversation = await createConversationWithFirstMessage({
    workspaceId: input.product.workspaceId,
    productId: input.product.id,
    contactId: contact.id,
    channel: "CHAT",
    subject,
    body,
    formPublicKey: input.product.formPublicKey,
  });
  if (!conversation.ok) return conversation;
  return { ok: true, ticketRef: formatTicketRef(conversation.ticketNumber) };
}

/**
 * Domain allowlist matching (FR-CHAT-01, design D7): exact hostname, or a
 * `*.example.com` entry covering subdomains (not the apex). Localhost is a
 * separate development path, allowed while the service itself runs in dev.
 */
export function isOriginAllowed(
  originHostname: string,
  productDomains: string[],
  serviceIsProduction: boolean,
): boolean {
  const hostname = originHostname.trim().toLowerCase();
  if (!hostname) return false;
  if (
    !serviceIsProduction &&
    (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1")
  ) {
    return true;
  }
  return productDomains.some((pattern) => {
    const rule = pattern.trim().toLowerCase();
    if (rule === hostname) return true;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return false;
  });
}

/** Extract the embedding page's hostname from Referer, or an explicit host param. */
export function resolveEmbeddingHostname(headers: Headers, hostParam?: string | null): string | null {
  const referer = headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).hostname;
    } catch {
      // fall through to host param
    }
  }
  if (hostParam) {
    try {
      return new URL(hostParam).hostname;
    } catch {
      return hostParam.trim().toLowerCase() || null;
    }
  }
  return null;
}

/**
 * Widget origin gate (FR-CHAT-01). The declared embedding host (sent by the
 * loader, which runs on the customer's page) must be allowlisted; when a
 * Referer is present it must agree or belong to the service itself. The
 * hardening spike (docs/design/chat-widget.md "Isolation approach") may
 * replace the declared-host trust with signed origin binding.
 */
export function isWidgetOriginAllowed(input: {
  productDomains: string[];
  hostParam: string | null | undefined;
  referer: string | null;
  serviceOrigin: string;
  serviceIsProduction: boolean;
  testToken?: string | null;
  productId?: string;
}): boolean {
  // Signed test token (design D8): the SupportSeal-hosted test page may load
  // this Product's widget for 30 minutes without an allowlist entry. The
  // referer must still be the service origin, and the token grants nothing
  // beyond a normal visitor session.
  if (input.testToken && input.productId) {
    // The token is bound to the service origin: the Referer must be present
    // and be the service itself (the hosted test page). A missing or
    // cross-site Referer is rejected, so a leaked token cannot be replayed
    // from an arbitrary host.
    let refererIsService = false;
    if (input.referer) {
      try {
        refererIsService = new URL(input.referer).origin === input.serviceOrigin;
      } catch {
        refererIsService = false;
      }
    }
    if (refererIsService && verifyWidgetTestToken(input.testToken, input.productId)) {
      return true;
    }
  }
  let declaredHostname: string | null = null;
  if (input.hostParam) {
    try {
      declaredHostname = new URL(input.hostParam).hostname;
    } catch {
      declaredHostname = input.hostParam.trim().toLowerCase() || null;
    }
  }
  if (!declaredHostname) return false;
  if (!isOriginAllowed(declaredHostname, input.productDomains, input.serviceIsProduction)) {
    return false;
  }

  if (input.referer) {
    try {
      const refererUrl = new URL(input.referer);
      const refererIsService = refererUrl.origin === input.serviceOrigin;
      if (!refererIsService && !isOriginAllowed(refererUrl.hostname, input.productDomains, input.serviceIsProduction)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function visitorCookieName(productId: string): string {
  return `ss_visitor_${productId}`;
}

/**
 * Visitor token transport: the cookie first, but third-party cookie blockers
 * (Safari ITP) drop it inside the embedded panel iframe — the panel then
 * presents the token via the x-ss-visitor-token header (from its partitioned
 * sessionStorage) or, for EventSource, the t= query parameter.
 */
export function visitorTokenFromRequest(
  request: { headers: Headers; nextUrl: URL },
  productId: string,
): string | undefined {
  return (
    getCookieValue(request.headers.get("cookie"), visitorCookieName(productId)) ??
    (request.headers.get("x-ss-visitor-token")?.trim() ||
      request.nextUrl.searchParams.get("t")?.trim() ||
      undefined)
  );
}

function getCookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) {
      // An empty value is absent (issue #82): a present-but-blank
      // ss_visitor_* cookie must not shadow the header/t= transports, key
      // the rate limiter's shared "" bucket, or 401 a request the panel
      // could otherwise authenticate.
      const value = part.slice(eq + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
}

export function hashVisitorToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type VisitorSession = {
  visitorId: string;
  productId: string;
  email: string | null;
  name: string | null;
  conversationId: string | null;
  origin: string | null;
};

export async function createVisitorSession(
  product: WidgetProduct,
  originParam: string | null,
): Promise<{
  token: string;
  session: VisitorSession;
}> {
  const token = randomBytes(32).toString("base64url");
  const origin = declaredOrigin(originParam);
  const visitor = await prisma.chatVisitor.create({
    data: {
      productId: product.id,
      tokenHash: hashVisitorToken(token),
      origin,
    },
  });
  return {
    token,
    session: {
      visitorId: visitor.id,
      productId: product.id,
      email: null,
      name: null,
      conversationId: null,
      origin,
    },
  };
}

/**
 * Ends a visitor session on host sign-out (issue #151): the token is swapped
 * for an unusable value so the cookie, the panel's sessionStorage copy and
 * any leaked copy all stop resolving, and the next boot mints a fresh
 * anonymous visitor. The row itself (identity, conversation) stays for
 * support. An unknown token is a no-op.
 */
export async function revokeVisitorSession(
  product: WidgetProduct,
  token: string | undefined,
): Promise<void> {
  if (!token) return;
  await prisma.chatVisitor.updateMany({
    where: { tokenHash: hashVisitorToken(token), productId: product.id },
    data: { tokenHash: `revoked:${randomBytes(32).toString("hex")}` },
  });
}

export async function resolveVisitorSession(
  product: WidgetProduct,
  token: string | undefined,
): Promise<VisitorSession | null> {
  if (!token) return null;
  // Claim activity atomically with session resolution: a concurrent purge
  // either deletes first (no session), or rechecks the refreshed timestamp
  // and spares this row before a handler can create a conversation.
  const [visitor] = await prisma.chatVisitor.updateManyAndReturn({
    where: { tokenHash: hashVisitorToken(token), productId: product.id },
    data: { lastSeenAt: new Date() },
  });
  if (!visitor) return null;
  return {
    visitorId: visitor.id,
    productId: visitor.productId,
    email: visitor.email,
    name: visitor.name,
    conversationId: visitor.conversationId,
    origin: visitor.origin,
  };
}

export async function touchVisitor(visitorId: string): Promise<void> {
  await prisma.chatVisitor.update({
    where: { id: visitorId },
    data: { lastSeenAt: new Date() },
  });
}

export async function setVisitorEmail(input: {
  visitor: VisitorSession;
  email: string;
}): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const email = normalizeContactEmail(input.email);
  if (!email) {
    return { ok: false, error: "Enter a valid email address." };
  }
  // Mail-loop guard: replies to a Product's own support/forwarding address
  // would be re-ingested (loop-guard.ts). Refuse it at the source.
  const product = await prisma.product.findUnique({
    where: { id: input.visitor.productId },
    select: { supportEmail: true, inboundEmail: true },
  });
  if (product && isOwnAddress(email, product)) {
    return { ok: false, error: "That is this team's own support address. Enter your own email address." };
  }
  const conversationId = input.visitor.conversationId;
  const conversation = conversationId
    ? await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, workspaceId: true, contactId: true },
      })
    : null;
  await prisma.$transaction(async (tx) => {
    await tx.chatVisitor.update({
      where: { id: input.visitor.visitorId },
      data: { email },
    });
    if (!conversation) return;
    // Email-takeover guard: a widget visitor claiming an email that already
    // belongs to a different contact must NOT hijack that contact's
    // conversation history. Only fill the email when it is free in the
    // Workspace; otherwise the claim is recorded on the visitor (agents see
    // it) and the conversation keeps its own contact.
    const existing = await tx.contact.findFirst({
      where: { workspaceId: conversation.workspaceId, email },
      select: { id: true },
    });
    if (!existing) {
      await tx.contact.update({
        where: { id: conversation.contactId },
        data: { email },
      });
    }
    // Move updatedAt so other app processes' inbox streams (signature over
    // the most recently updated conversations) notice the change too.
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });
  });
  if (conversation) {
    notifyConversationEvent({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      kind: "context",
    });
  }
  return { ok: true, email };
}

/**
 * A visitor message. Creates the Conversation (and Workspace contact) on the
 * first message; a closed Conversation reopens (V1 requirement). The page
 * URL is recorded automatically by the widget (origin + path only).
 *
 * `diagnostics` is the optional browser-diagnostics snapshot from the widget
 * (docs/design/diagnostics.md): validated, re-redacted and bounded here —
 * invalid or oversized diagnostics never reject the message.
 */
export async function visitorSendMessage(input: {
  product: WidgetProduct;
  visitor: VisitorSession;
  body: string;
  pageUrl?: string | null;
  attachmentIds?: string[];
  diagnostics?: unknown;
  userAgent?: string;
}): Promise<
  | { ok: true; conversationId: string; diagnostics?: CustomerMessageDiagnosticsOutcome }
  | { ok: false; error: string; paused?: true }
> {
  const body = input.body.trim().slice(0, 5000);
  if (!body) return { ok: false, error: "Message is empty." };
  if (await isServicePaused(input.product.workspaceId)) {
    return { ok: false, error: SERVICE_PAUSED_CODE, paused: true };
  }

  // Diagnostics gate: the Product must have diagnostics enabled *now*.
  let snapshot: NormalizedSnapshot | null = null;
  let diagnosticsOutcome: CustomerMessageDiagnosticsOutcome | undefined;
  if (input.diagnostics !== undefined) {
    if (input.product.diagnosticsEnabledAt === null) {
      diagnosticsOutcome = { status: "rejected", reason: "disabled" };
    } else {
      const visitorRow = await prisma.chatVisitor.findUnique({
        where: { id: input.visitor.visitorId },
        select: { devContext: true },
      });
      const normalized = normalizeSnapshot(input.diagnostics, {
        userAgent: input.userAgent ?? "",
        devContext: visitorRow?.devContext,
      });
      if (normalized.ok) {
        snapshot = normalized.snapshot;
      } else {
        diagnosticsOutcome = { status: "rejected", reason: normalized.reason };
      }
    }
    // Log the reason code and Product ID only, never snapshot content.
    if (diagnosticsOutcome && diagnosticsOutcome.status === "rejected") {
      console.warn(
        `[diagnostics] snapshot rejected product=${input.product.id} reason=${diagnosticsOutcome.reason}`,
      );
    }
  }

  let conversationId = input.visitor.conversationId;
  if (conversationId) {
    const existing = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId: input.product.workspaceId },
      select: { id: true },
    });
    if (!existing) conversationId = null;
  }

  if (!conversationId) {
    // Upsert: the visitor may have supplied an email (away form) that already
    // belongs to a Workspace contact — reuse it instead of violating the
    // unique [workspaceId, email] constraint.
    const contact = await upsertContact({
      workspaceId: input.product.workspaceId,
      email: input.visitor.email,
      name: input.visitor.name,
    });
    const conversation = await prisma.$transaction(async (tx) =>
      tx.conversation.create({
        data: {
          workspaceId: input.product.workspaceId,
          ticketNumber: await allocateTicketNumber(tx, input.product.workspaceId),
          productId: input.product.id,
          contactId: contact.id,
          channel: "CHAT",
        },
      }),
    );
    conversationId = conversation.id;
    // Hosted only, fire-and-forget: never blocks or fails intake (FR-USE-02).
    notifyAllowanceInBackground(input.product.workspaceId);
    await prisma.chatVisitor.update({
      where: { id: input.visitor.visitorId },
      data: { conversationId, createdConversationAt: new Date() },
    });
  }
  input.visitor.conversationId = conversationId;

  const message = await addCustomerMessage({
    workspaceId: input.product.workspaceId,
    conversationId,
    body,
    source: { kind: "visitor", visitorId: input.visitor.visitorId },
    attachmentIds: input.attachmentIds,
    diagnostics: snapshot ?? undefined,
  });
  if (!message.ok) return message;
  if (message.diagnostics && !diagnosticsOutcome) diagnosticsOutcome = message.diagnostics;

  if (input.pageUrl) {
    // Merge the recorded page URL into the stored context without clobbering
    // developer-supplied identify()/context() data.
    const visitorRow = await prisma.chatVisitor.findUnique({
      where: { id: input.visitor.visitorId },
      select: { devContext: true },
    });
    await prisma.chatVisitor.update({
      where: { id: input.visitor.visitorId },
      data: {
        devContext: mergeDevContext(visitorRow?.devContext, {
          pageUrl: input.pageUrl.slice(0, 300),
        }) as Prisma.InputJsonValue,
      },
    });
  }

  await touchVisitor(input.visitor.visitorId);
  return {
    ok: true,
    conversationId,
    ...(diagnosticsOutcome ? { diagnostics: diagnosticsOutcome } : {}),
  };
}

export type VisitorMessage = {
  id: string;
  kind: "CUSTOMER" | "AGENT";
  body: string;
  createdAt: string;
};

/** Customer-visible thread for the visitor (notes are never included). */
export async function visitorListMessages(input: {
  product: WidgetProduct;
  visitor: VisitorSession;
}): Promise<{
  conversationId: string | null;
  /** Customer-facing ticket reference (SS-123); null before the first message. */
  ticketRef: string | null;
  messages: VisitorMessage[];
  status: string;
}> {
  if (!input.visitor.conversationId) return { conversationId: null, ticketRef: null, messages: [], status: "OPEN" };
  const detail = await getConversationDetail({
    workspaceId: input.product.workspaceId,
    conversationId: input.visitor.conversationId,
  });
  if (!detail) return { conversationId: null, ticketRef: null, messages: [], status: "OPEN" };
  await touchVisitor(input.visitor.visitorId);
  return {
    conversationId: detail.id,
    ticketRef: formatTicketRef(detail.ticketNumber),
    status: detail.status,
    messages: detail.messages
      .filter((m): m is (typeof detail.messages)[number] & { kind: "CUSTOMER" | "AGENT" } => m.kind === "CUSTOMER" || m.kind === "AGENT")
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        attachments: m.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      })),
  };
}

/**
 * identify()/context() persistence (FR-CTX-01/02). Identity fields update the
 * visitor (and the contact email like the capture card); context is validated,
 * bounded and merged into the stored JSON. Nothing here trusts the payload.
 */
export async function setVisitorIdentityAndContext(input: {
  visitor: VisitorSession;
  identity?: VisitorIdentity;
  context?: Record<string, unknown>;
}): Promise<{ ok: true; email: string | null } | { ok: false; error: string }> {
  const visitor = await prisma.chatVisitor.findUnique({ where: { id: input.visitor.visitorId } });
  if (!visitor) return { ok: false, error: "Session not found." };

  const data: {
    name?: string;
    externalUserId?: string;
    devContext?: Prisma.InputJsonValue;
  } = {};
  let emailResult: { ok: true; email: string } | { ok: false; error: string } | null = null;

  if (input.identity?.name) data.name = input.identity.name;
  if (input.identity?.userId) data.externalUserId = input.identity.userId;
  if (input.identity?.email && input.identity.email !== visitor.email) {
    emailResult = await setVisitorEmail({ visitor: input.visitor, email: input.identity.email });
    if (!emailResult.ok) return emailResult;
  }
  if (input.context && Object.keys(input.context).length > 0) {
    data.devContext = mergeDevContext(visitor.devContext, input.context) as Prisma.InputJsonValue;
  }

  if (Object.keys(data).length > 0) {
    await prisma.chatVisitor.update({ where: { id: visitor.id }, data });
    if (visitor.conversationId) {
      notifyConversationEvent({
        conversationId: visitor.conversationId,
        workspaceId: visitor.productId ? (await prisma.product.findUnique({ where: { id: visitor.productId }, select: { workspaceId: true } }))!.workspaceId : "",
        kind: "context",
      });
    }
  }
  return { ok: true, email: emailResult?.ok ? emailResult.email : visitor.email };
}

/**
 * The service origin as the client addressed it: forwarded host (proxy) or
 * Host header — NOT request.nextUrl.origin, which reflects the bind address
 * (0.0.0.0) rather than the public host.
 */
export function serviceOriginFrom(headers: Headers, fallback: string): string {
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
  if (!host) return fallback;
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto || (host.includes("localhost") || /^\d+\.\d+\.\d+\.\d+/u.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * The origin a widget session is bound to: scheme + host + port of the
 * embedding page (issue #61). Cookies and storage partition keys ignore
 * ports, so binding to the hostname alone let a session created on one port
 * resurface on another port of the same host — a "fresh" embed that still
 * carried the previous visitor's conversation. A bare hostname defaults to
 * https, matching how production sites embed the widget.
 */
export function declaredOrigin(hostParam: string | null | undefined): string | null {
  if (!hostParam) return null;
  const raw = hostParam.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * Guard a visitor request: origin gate + session binding. The session is
 * pinned to the origin that passed the allowlist when it was created, so a
 * later request cannot claim a different (allowlisted) host for the same
 * cookie, and a stolen cookie cannot be replayed from another origin. A
 * session with no recorded origin never matches (issue #61): rows from
 * before origin binding — and sessions the origin gate admits without a
 * host, e.g. test-token boots — simply start fresh on their next boot
 * instead of resuming everywhere.
 */
export function sessionOriginMatches(
  session: VisitorSession,
  hostParam: string | null | undefined,
): boolean {
  if (!session.origin) return false;
  return declaredOrigin(hostParam) === session.origin;
}

/**
 * Session resolution for the panel boot (issue #61). Returns the session
 * only when the token is valid and was issued for this exact origin.
 * Any other credential — a different port, domain, or scheme — returns
 * null so the caller starts a fresh anonymous session.
 */
export async function resolveBootSession(
  product: WidgetProduct,
  token: string | undefined,
  hostParam: string | null | undefined,
): Promise<VisitorSession | null> {
  const session = await resolveVisitorSession(product, token);
  if (session && sessionOriginMatches(session, hostParam)) return session;
  return null;
}

/**
 * CSRF defence for state-changing widget requests (POST/PUT): browsers
 * always send Origin on cross-origin POSTs, and the panel iframe's own
 * same-origin POSTs carry the service origin. Any other Origin is rejected.
 * Absent Origin (non-browser clients) is allowed — the origin gate and
 * session binding still apply.
 */
export function widgetRequestOriginOk(
  originHeader: string | null,
  serviceOrigin: string,
): boolean {
  if (!originHeader) return true;
  try {
    return new URL(originHeader).origin === serviceOrigin;
  } catch {
    return false;
  }
}

export async function getAvailabilityForProduct(workspaceId: string): Promise<"LIVE" | "AWAY"> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { availability: true },
  });
  return workspace?.availability ?? "LIVE";
}
