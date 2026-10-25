import { NextResponse, type NextRequest } from "next/server";

import {
  INBOUND_AUTH_HEADER,
  InboundRejectError,
  basicAuthSecretCandidates,
  headersFromBody,
  parseAddress,
  parseAddressList,
  processInboundEmail,
  secretMatches,
  type InboundEmail,
} from "@/lib/email/inbound";
import {
  MAX_INBOUND_BYTES,
  parseSendgridInbound,
  type SendgridInboundMeta,
} from "@/lib/email/providers/sendgrid";

export const dynamic = "force-dynamic";

/**
 * Inbound email webhook (ADR-0004). Accepts SendGrid Inbound Parse
 * multipart posts or the same fields as JSON (self-host bridge). Auth: the
 * shared secret via the x-supportseal-inbound-secret header, the ?secret=
 * query parameter or Basic-Auth userinfo (SendGrid destination URLs can
 * embed the latter two; the route does not verify SendGrid's optional signature yet). Duplicate
 * deliveries are idempotent; rejections never leak Product existence.
 *
 * SendGrid retries any non-2xx for up to 72 hours and offers no failure
 * dashboard, so every outcome is logged with enough context to debug
 * (Message-ID, recipients, SPF/DKIM/spam verdicts — never message bodies).
 * Unparseable posts return 400 and unexpected errors 500 so retries can
 * recover once a bug is fixed; accepted mail (even if bounced) returns 200.
 */
export async function POST(request: NextRequest) {
  const basicCandidates = basicAuthSecretCandidates(request.headers.get("authorization"));
  const authenticated =
    secretMatches(request.headers.get(INBOUND_AUTH_HEADER)) ||
    secretMatches(request.nextUrl.searchParams.get("secret")) ||
    basicCandidates.some((candidate) => secretMatches(candidate));
  if (!authenticated) {
    console.warn("[inbound-email] rejected unauthenticated post");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let email: InboundEmail;
  let meta: SendgridInboundMeta | null = null;
  try {
    if (contentType.includes("application/json")) {
      // Same byte cap as multipart: request.json() would buffer the body
      // unbounded (a chunked post has no trustworthy Content-Length).
      const bytes = await readBodyCapped(request, MAX_INBOUND_BYTES);
      if (!bytes) return badRequest(`body larger than ${MAX_INBOUND_BYTES} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return badRequest("invalid JSON body");
      }
      email = fromJsonBody(parsed as Record<string, unknown>);
    } else {
      const bytes = await readBodyCapped(request, MAX_INBOUND_BYTES);
      if (!bytes) return badRequest(`body larger than ${MAX_INBOUND_BYTES} bytes`);
      ({ email, meta } = parseSendgridInbound(bytes, contentType));
    }
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "unparseable payload");
  }

  const summary = {
    messageId: email.headers.messageId,
    to: email.to,
    fromDomain: email.from.email.split("@")[1],
    attachments: email.attachments.length,
    ...(meta ? { spf: meta.spf, dkim: meta.dkim, spamScore: meta.spamScore, senderIp: meta.senderIp } : {}),
  };

  try {
    const result = await processInboundEmail({ email });
    if (result.outcome === "rejected") {
      console.warn("[inbound-email] rejected", { ...summary, reason: result.reason });
    } else {
      console.info(`[inbound-email] ${result.outcome}`, summary);
    }
    // Every outcome is acknowledged so senders retry nothing; rejected mail
    // still returns 200 (the bounce itself is sent by the outbound slice).
    const ack = {
      created: {},
      duplicate: { duplicate: true },
      ignored: { ignored: true },
      rejected: { rejected: true },
    }[result.outcome];
    return NextResponse.json({ ok: true, ...ack });
  } catch (error) {
    if (error instanceof InboundRejectError) {
      console.warn("[inbound-email] rejected", { ...summary, code: error.code, reason: error.message });
      const status = error.code === "duplicate" ? 200 : error.code === "unauthorized" ? 401 : 400;
      return NextResponse.json({ error: error.code }, { status });
    }
    console.error("[inbound-email] processing failed", summary, error);
    throw error;
  }
}

/**
 * Read the request body, giving up as soon as it exceeds `limit` bytes (a
 * chunked post has no trustworthy Content-Length). Returns null when too big.
 */
async function readBodyCapped(request: NextRequest, limit: number): Promise<Buffer | null> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function badRequest(reason: string) {
  console.error("[inbound-email] bad request:", reason);
  return NextResponse.json({ error: "bad_request" }, { status: 400 });
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function fromJsonBody(body: Record<string, unknown>): InboundEmail {
  const from = parseAddress(str(body.from));
  if (!from) throw new Error("invalid from");
  return {
    from,
    to: parseAddressList(str(body.to)),
    subject: str(body.subject),
    text: str(body.text),
    html: str(body.html),
    headers: headersFromBody(body),
    attachments: [],
  };
}
