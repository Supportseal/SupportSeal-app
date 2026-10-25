import { randomUUID } from "node:crypto";

import type { OutboundPayload, OutboundTransport } from "@/lib/email/outbound";
import {
  parseAddress,
  parseAddressList,
  parseRawHeaders,
  headersFromBody,
  lowercaseKeys,
  type InboundEmail,
} from "@/lib/email/inbound";

/**
 * SendGrid adapter (ADR-0004 — hosted provider since 2026-10-06, see
 * docs/open-questions.md §8). Outbound: the v3 mail/send API
 * (SENDGRID_API_KEY, Mail Send scope only). Inbound: Inbound Parse posts
 * multipart/form-data; SendGrid can sign it, but the route does not verify that
 * signature yet and relies on the shared secret carried in the destination URL
 * (?secret=). There is no
 * provider message id per inbound mail — dedupe is by the RFC 5322
 * Message-ID header (processInboundEmail).
 */

const SENDGRID_SEND_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

type SendgridSend = (payload: OutboundPayload) => Promise<{ messageId: string | null }>;

const globalForSendgrid = globalThis as unknown as { __supportsealSendgridSend?: SendgridSend };

/** Test seam: inject a SendGrid sender (or null to fall back to env config). */
export function setSendgridSendForTest(send: SendgridSend | null): void {
  globalForSendgrid.__supportsealSendgridSend = send ?? undefined;
}

/**
 * Split `Name <local@domain>` (or a bare address) into name and email. SendGrid
 * validates the address itself, so this stays lenient (e.g. dotless dev hosts).
 */
function splitMailbox(value: string | undefined): { email: string; name: string | null } | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const bracket = /^(.*)<([^<>]+)>\s*$/u.exec(trimmed);
  const email = (bracket ? bracket[2] : trimmed).trim();
  if (!email.includes("@")) return null;
  const name = bracket ? bracket[1].trim().replace(/^"|"$/gu, "").trim() : "";
  return { email, name: name || null };
}

/** Domain of a `Name <local@domain>` sender address. */
function senderDomain(from: string): string {
  return splitMailbox(from)?.email.split("@")[1] ?? "supportseal.invalid";
}

type SendgridErrorBody = { errors?: Array<{ message?: string; field?: string | null }> };

async function sendWithSendgrid(apiKey: string, payload: OutboundPayload): Promise<{ messageId: string | null }> {
  // Reply-To is a first-class API field on SendGrid and a reserved header.
  const { "Reply-To": replyTo, ...headers } = payload.headers;
  // We set the RFC Message-ID ourselves so the stored providerMessageId is
  // the id customers' replies quote in In-Reply-To/References (ADR-0004).
  // Reply-token Reply-To routing is the primary threading path either way.
  let messageId: string | null = headers["Message-ID"] ?? null;
  if (!messageId) {
    messageId = `<${randomUUID()}@${senderDomain(payload.from)}>`;
    headers["Message-ID"] = messageId;
  }
  const from = splitMailbox(payload.from);
  if (!from) throw new Error("sendgrid send failed: invalid from address");
  const replyToAddress = splitMailbox(replyTo);
  const body = {
    personalizations: [{ to: [{ email: splitMailbox(payload.to)?.email ?? payload.to }] }],
    from: { email: from.email, ...(from.name ? { name: from.name } : {}) },
    ...(replyToAddress ? { reply_to: { email: replyToAddress.email } } : {}),
    // Subjects can echo untrusted inbound text (bounce notices): no line breaks.
    subject: payload.subject.replace(/[\r\n]+/gu, " "),
    // text/plain must come first; an optional html part makes it multipart/alternative.
    content: [
      { type: "text/plain", value: payload.text || " " },
      ...(payload.html ? [{ type: "text/html", value: payload.html }] : []),
    ],
    headers,
    // Never rewrite links or add tracking pixels, plain-text or HTML.
    tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
    ...(payload.attachments && payload.attachments.length > 0
      ? {
          attachments: payload.attachments.map((a) => ({
            content: a.content.toString("base64"),
            filename: a.filename,
            type: a.contentType,
            disposition: "attachment",
          })),
        }
      : {}),
  };
  const response = await fetch(SENDGRID_SEND_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as SendgridErrorBody | null;
    const detail =
      data?.errors?.map((e) => (e.field ? `${e.message} (${e.field})` : e.message)).filter(Boolean).join("; ") ||
      response.statusText;
    throw new Error(`sendgrid send failed (${response.status}): ${detail}`);
  }
  return { messageId };
}

/**
 * Outbound transport backed by the SendGrid API, or null when SendGrid is
 * not configured (no key) and no test sender is injected.
 */
export function sendgridTransport(): OutboundTransport | null {
  const injected = globalForSendgrid.__supportsealSendgridSend;
  if (injected) return { send: injected };
  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  if (!apiKey) return null;
  return { send: (payload) => sendWithSendgrid(apiKey, payload) };
}

// ---------------------------------------------------------------------------
// Inbound Parse (multipart/form-data → provider-neutral InboundEmail)
// ---------------------------------------------------------------------------

/** SendGrid caps a whole inbound message at 30 MB; leave headroom for encoding. */
export const MAX_INBOUND_BYTES = 35 * 1024 * 1024;
const MAX_FILES = 10;

export type MultipartPart = {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
};

/**
 * Minimal multipart/form-data parser that keeps field bytes intact.
 * `Request.formData()` always decodes text as UTF-8, but Inbound Parse posts
 * each field in the original message charset (named in the `charsets`
 * field), so decoding must happen after parsing, per field.
 */
export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const boundaryText = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundaryText) throw new Error("multipart boundary missing");
  const delimiter = Buffer.from(`--${boundaryText}`);
  const separator = Buffer.from(`\r\n--${boundaryText}`);

  const parts: MultipartPart[] = [];
  let position = body.indexOf(delimiter);
  if (position < 0) throw new Error("multipart delimiter not found");
  for (;;) {
    let start = position + delimiter.length;
    if (body.subarray(start, start + 2).toString("latin1") === "--") break;
    const lineEnd = body.indexOf("\r\n", start);
    if (lineEnd < 0) throw new Error("malformed multipart delimiter");
    start = lineEnd + 2;
    const next = body.indexOf(separator, start);
    if (next < 0) throw new Error("unterminated multipart body");
    const raw = body.subarray(start, next);
    position = next + 2;

    let headerText = "";
    let data = raw;
    if (raw.subarray(0, 2).toString("latin1") === "\r\n") {
      data = raw.subarray(2);
    } else {
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd < 0) throw new Error("malformed multipart part");
      headerText = raw.subarray(0, headerEnd).toString("latin1");
      data = raw.subarray(headerEnd + 4);
    }
    const headers = parseRawHeaders(headerText);
    const lower = lowercaseKeys(headers);
    const disposition = lower["content-disposition"] ?? "";
    const name = /(?:^|;)\s*name="((?:[^"\\]|\\.)*)"/iu.exec(disposition)?.[1];
    if (name === undefined) continue; // not a form field
    const filename = /(?:^|;)\s*filename="((?:[^"\\]|\\.)*)"/iu.exec(disposition)?.[1];
    parts.push({
      name,
      filename: filename !== undefined ? Buffer.from(filename, "latin1").toString("utf8") : null,
      contentType: lower["content-type"] ?? null,
      data,
    });
  }
  return parts;
}

function decodeText(data: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset?.trim() || "utf-8").decode(data);
  } catch {
    return data.toString("utf8"); // unknown charset label
  }
}

function jsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Verdict/diagnostic fields SendGrid attaches; logged, never trusted for routing. */
export type SendgridInboundMeta = {
  envelopeTo: string[];
  spf: string | null;
  dkim: string | null;
  spamScore: string | null;
  senderIp: string | null;
};

/**
 * Normalise an Inbound Parse multipart body. Everything is untrusted: fields
 * degrade to null; only a message with no usable sender is rejected.
 * "Send Raw" mode (full MIME in an `email` field) is not supported and is
 * rejected explicitly so a misconfigured hostname fails loudly.
 */
export function parseSendgridInbound(
  body: Buffer,
  contentType: string,
): { email: InboundEmail; meta: SendgridInboundMeta } {
  const parts = parseMultipart(body, contentType);
  const fields = new Map<string, Buffer>();
  const files: MultipartPart[] = [];
  for (const part of parts) {
    if (part.filename !== null) files.push(part);
    else if (!fields.has(part.name)) fields.set(part.name, part.data);
  }
  if (fields.has("email") && !fields.has("text") && !fields.has("html")) {
    throw new Error('Inbound Parse "Send Raw" is enabled; disable it (SupportSeal expects parsed fields)');
  }

  const charsets = jsonObject(fields.get("charsets")?.toString("utf8") ?? null);
  const get = (name: string) => {
    const data = fields.get(name);
    if (!data) return null;
    const charset = typeof charsets[name] === "string" ? (charsets[name] as string) : undefined;
    const value = decodeText(data, name === "headers" || name === "envelope" ? "utf-8" : charset);
    return value.trim() ? value : null;
  };

  const envelope = jsonObject(get("envelope"));
  const envelopeTo = (Array.isArray(envelope.to) ? envelope.to : [])
    .flatMap((entry) => (typeof entry === "string" ? parseAddressList(entry) : []));
  const envelopeFrom = typeof envelope.from === "string" ? parseAddress(envelope.from) : null;
  const from = parseAddress(get("from")) ?? envelopeFrom;
  if (!from) throw new Error("invalid from");

  const rawHeaders = get("headers");
  const headerMap = rawHeaders ? parseRawHeaders(rawHeaders) : {};
  const cc = Object.entries(headerMap).find(([key]) => key.toLowerCase() === "cc")?.[1];
  // Envelope recipients (the address that actually reached us) first, then
  // the To/Cc headers (a Product may be Cc'd); de-duplicated in order.
  const to = [...new Set([...envelopeTo, ...parseAddressList(get("to")), ...parseAddressList(cc)])];

  // attachment-info maps attachmentN → original filename/type/content-id.
  const info = jsonObject(get("attachment-info"));
  const attachments: InboundEmail["attachments"] = [];
  for (const file of files) {
    if (attachments.length >= MAX_FILES) break;
    if (file.data.length === 0) continue;
    const meta = typeof info[file.name] === "object" && info[file.name] !== null
      ? (info[file.name] as Record<string, unknown>)
      : {};
    const metaName = typeof meta.filename === "string" && meta.filename.trim() ? meta.filename : null;
    const metaType = typeof meta.type === "string" && meta.type.trim() ? meta.type : null;
    attachments.push({
      filename: metaName ?? (file.filename || file.name),
      contentType: (metaType ?? file.contentType ?? "application/octet-stream").split(";")[0].trim(),
      data: new Uint8Array(file.data),
    });
  }

  return {
    email: {
      from,
      to,
      subject: get("subject"),
      text: get("text"),
      html: get("html"),
      headers: headersFromBody({ headers: rawHeaders ?? undefined }),
      attachments,
    },
    meta: {
      envelopeTo,
      spf: get("SPF"),
      dkim: get("dkim"),
      spamScore: get("spam_score"),
      senderIp: get("sender_ip"),
    },
  };
}
