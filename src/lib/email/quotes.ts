import { htmlToText } from "@/lib/email/html-text";

/**
 * Conservative quoted-reply stripping for inbound email (issue #128).
 * Over-stripping loses real customer content, so every rule only removes
 * text it can confidently attribute to the quoted original:
 *
 * - plain text: the "On <date>, <sender> wrote:" footer line plus the
 *   "> "-prefixed quoted lines that follow it — and only when at least one
 *   "> " quoted line actually follows. Anything else — inline answers
 *   inside the quote, bottom-posted replies, signatures — is kept.
 * - HTML-only mail (no text/plain): Gmail (`gmail_quote`), Outlook web
 *   (`#appendonsend`) and Outlook desktop (`#divRplyFwdMsg` From/Sent/To/
 *   Subject header) wrap or fence the quoted original in identifiable
 *   elements; those are removed. HTML without a confident marker keeps
 *   everything and only the plain-text rules above apply to the converted
 *   text.
 *
 * No "-----Original Message-----" / bare "From: … Sent: …" plain-text
 * headers are stripped: without markers they are indistinguishable from
 * real body text, so they are kept (conservative default).
 */

/** Recognizable client attribution; ordinary numbered prose is not enough. */
const ON_WROTE_LINE = /^On\s[^\n]{2,300}?wrote:\s*$/u;
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DAY = "(?:0?[1-9]|[12][0-9]|3[01])";
const NUMERIC_MONTH = "(?:0?[1-9]|1[0-2])";
const YEAR = "(?:[12][0-9]{3}|[0-9]{2})";
const DATE_PREFIX = new RegExp(
  `^On\\s+(?:(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?),?\\s+)?(?:${NUMERIC_MONTH}[/.-]${DAY}[/.-]${YEAR}|${DAY}[/.-]${NUMERIC_MONTH}[/.-]${YEAR}|[12][0-9]{3}-${NUMERIC_MONTH}-${DAY}|${MONTH}\\s+${DAY},?\\s+[12][0-9]{3}|${DAY}\\s+${MONTH}\\s+[12][0-9]{3})\\b`,
  "iu",
);

/** A line belonging to the quoted original ("> ", ">", ">>", optional indent). */
const QUOTED_LINE = /^\s*>/u;

function isQuoteHeaderLine(line: string): boolean {
  return ON_WROTE_LINE.test(line) && DATE_PREFIX.test(line);
}

/**
 * Strip only the contiguous quoted/blank block immediately after the
 * header. Once customer prose resumes, preserve everything that follows,
 * including their own quoted lines. Without an immediate quote, keep all.
 */
export function stripQuotedReplyText(text: string): string {
  const lines = text.split(/\r?\n/u);
  const header = lines.findIndex(isQuoteHeaderLine);
  if (header === -1) return text;
  const tail = lines.slice(header + 1);
  const firstContent = tail.findIndex((line) => line.trim());
  if (firstContent === -1 || !QUOTED_LINE.test(tail[firstContent])) return text;
  const replyStart = tail.findIndex((line) => line.trim() && !QUOTED_LINE.test(line));
  return [...lines.slice(0, header), ...(replyStart === -1 ? [] : tail.slice(replyStart))]
    .join("\n").trim();
}

function attributeValue(openTag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "iu").exec(openTag);
  if (!match) return null;
  return match[2] !== undefined ? match[2] : (match[3] ?? "");
}

/** Gmail wraps the quoted original (and its "On … wrote:" prefix) in gmail_quote elements. */
function isGmailQuote(openTag: string): boolean {
  return attributeValue(openTag, "class")
    ?.split(/\s+/u)
    .includes("gmail_quote") === true;
}

/** Outlook web appends the original message inside #appendonsend. */
function isOutlookAppendOnSend(openTag: string): boolean {
  return attributeValue(openTag, "id") === "appendonsend";
}

/** Outlook desktop fences the original behind a #divRplyFwdMsg header block. */
function isOutlookReplyHeader(openTag: string): boolean {
  return attributeValue(openTag, "id") === "divRplyFwdMsg";
}

/**
 * #divRplyFwdMsg content must actually look like the From/Sent/To/Subject
 * header Outlook generates — the id alone is not trusted.
 */
function looksLikeOutlookHeaderBlock(elementHtml: string): boolean {
  const labels = elementHtml.replace(/<[^>]+>/gu, " ");
  return /From:/iu.test(labels) && /(Sent|To|Subject):/iu.test(labels);
}

/**
 * Index just past the closing tag matching the element opened at `from`
 * (same tag name only — other tags don't affect the balance). -1 when
 * unbalanced, in which case the caller keeps the element.
 */
function findElementEnd(html: string, from: number, tag: string): number {
  const tokens = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, "giu");
  tokens.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html)) !== null) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return -1;
}

/**
 * Remove confidently identified quoted-original elements from reply HTML.
 * Unbalanced or unmarked elements are kept — never guess. A confident
 * #divRplyFwdMsg header removes everything after it too: Outlook desktop
 * places the quoted original there, below the customer's reply.
 */
export function stripKnownQuoteHtml(html: string): string {
  let out = html;
  let removed = true;
  while (removed) {
    removed = false;
    for (const match of out.matchAll(/<(div|blockquote)\b[^>]*>/giu)) {
      const openTag = match[0];
      const tag = match[1].toLowerCase();
      if (
        !isGmailQuote(openTag) &&
        !isOutlookAppendOnSend(openTag) &&
        !isOutlookReplyHeader(openTag)
      ) {
        continue;
      }
      const end = findElementEnd(out, match.index + openTag.length, tag);
      if (end === -1) continue;
      if (isOutlookReplyHeader(openTag)) {
        const content = out.slice(match.index + openTag.length, end).replace(/<\/div\s*>$/iu, "");
        if (!looksLikeOutlookHeaderBlock(content)) continue;
        out = out.slice(0, match.index);
      } else {
        out = out.slice(0, match.index) + out.slice(end);
      }
      removed = true;
      break;
    }
  }
  return out;
}

/**
 * The customer-visible body of an inbound email: the text/plain part when
 * present (quote-stripped), otherwise the HTML part with confidently
 * identified quoted sections removed before conversion. Empty string when
 * the mail carries no usable body.
 */
export function inboundBodyText(email: { text: string | null; html: string | null }): string {
  const text = email.text?.trim() ?? "";
  if (text) return stripQuotedReplyText(text);
  if (email.html) return stripQuotedReplyText(htmlToText(stripKnownQuoteHtml(email.html)));
  return "";
}
