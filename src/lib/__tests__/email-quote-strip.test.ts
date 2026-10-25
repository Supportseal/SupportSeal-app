import { describe, expect, it } from "vitest";

import { htmlToText } from "@/lib/email/html-text";
import { inboundBodyText, stripKnownQuoteHtml, stripQuotedReplyText } from "@/lib/email/quotes";

describe("stripQuotedReplyText (issue #128)", () => {
  it.each(["On issue 128, Alice wrote:", "On version 2.0, Alice wrote:", "On 31/31/2026, Alice wrote:"])(
    "preserves an ambiguous numbered attribution: %s", (header) => {
      const text = `My context\n${header}\n> A quotation I want to keep`;
      expect(stripQuotedReplyText(text)).toBe(text);
    },
  );

  it("strips the live-support Outlook shape: reply + 'On <date>, <sender> wrote:' + quoted tail", () => {
    const text = [
      "not sure how i feel about this",
      "On 10/9/2026 9:53 AM, IndieDevTest Support wrote:",
      "> thanks oldie",
    ].join("\n");
    expect(stripQuotedReplyText(text)).toBe("not sure how i feel about this");
  });

  it("strips nested quoted lines (reply-of-a-reply tails)", () => {
    const text = [
      "not sure how i feel about this",
      "On 10/9/2026 9:53 AM, IndieDevTest Support wrote:",
      ">> thanks oldie",
      "",
      "> > an earlier reply",
    ].join("\n");
    expect(stripQuotedReplyText(text)).toBe("not sure how i feel about this");
  });

  it("strips the Gmail header shape with the sender address", () => {
    const text = [
      "That works for me, thanks!",
      "",
      "On Fri, Oct 9, 2026 at 9:53 AM IndieDevTest Support <support@supportseal.app> wrote:",
      "> thanks oldie",
    ].join("\n");
    expect(stripQuotedReplyText(text)).toBe("That works for me, thanks!");
  });

  it("keeps prose that merely matches the header pattern when no quoted lines follow", () => {
    const text = "On 9 Oct, I wrote:\nPlease keep this entire message.";
    expect(stripQuotedReplyText(text)).toBe(text);
  });

  it("keeps inline replies and later quoted lines after customer prose resumes", () => {
    const text = [
      "Answers below.",
      "",
      "On Fri, Oct 9, 2026 at 9:53 AM Support wrote:",
      "> first question",
      "first answer",
      "> second question",
      "second answer",
    ].join("\n");
    expect(stripQuotedReplyText(text)).toBe("Answers below.\n\nfirst answer\n> second question\nsecond answer");
  });

  it("preserves a customer's own quotes in a bottom-posted reply", () => {
    const text = "On 10/9/2026 9:53 AM, Support wrote:\n> original\n\nMy reply:\n> my own quote";
    expect(stripQuotedReplyText(text)).toBe("My reply:\n> my own quote");
  });

  it("keeps an attribution-like sentence when prose precedes a later quote", () => {
    const text = "On 9 Oct, I wrote:\nThis is my explanation.\n> my own quote";
    expect(stripQuotedReplyText(text)).toBe(text);
  });

  it("keeps bottom-posted replies after the quoted block", () => {
    const text = [
      "On Fri, Oct 9, 2026 at 9:53 AM Support wrote:",
      "> the original message",
      "",
      "my reply underneath the quote",
    ].join("\n");
    expect(stripQuotedReplyText(text)).toBe("my reply underneath the quote");
  });

  it("keeps a signature-only reply (no actual reply text)", () => {
    const text = [
      "--",
      "Jane Doe",
      "Founder, Example Inc.",
      "On Mon, Oct 5, 2026 at 4:20 PM Support wrote:",
      "> original text",
    ].join("\n");
    expect(stripQuotedReplyText(text)).toBe("--\nJane Doe\nFounder, Example Inc.");
  });

  it("keeps everything when there is no quote header", () => {
    const text = "On Monday we ship the release.\n\n> a line I quoted myself";
    expect(stripQuotedReplyText(text)).toBe(text);
  });

  it("keeps 'wrote:' sentences without a date digit", () => {
    const text = "On reflection, the author wrote:\n> something";
    expect(stripQuotedReplyText(text)).toBe(text);
  });

  it("handles CRLF line endings and trailing blank lines", () => {
    const text = "works for me\r\n\r\nOn 10/9/2026 9:53 AM, Support wrote:\r\n> original\r\n";
    expect(stripQuotedReplyText(text)).toBe("works for me");
  });
});

describe("htmlToText paragraph separation", () => {
  it("separates adjacent div paragraphs (never merges body text)", () => {
    expect(htmlToText("<div>first paragraph</div><div>second paragraph</div>")).toBe(
      "first paragraph\nsecond paragraph",
    );
    expect(htmlToText("<p>Hi<br>there</p>")).toBe("Hi\nthere");
  });
});

describe("stripKnownQuoteHtml (issue #128)", () => {
  it("removes the Gmail quote wrapper including the 'On … wrote:' prefix and blockquote", () => {
    const html = [
      '<div dir="ltr">Here is my reply text</div>',
      '<div class="gmail_quote">',
      '<div class="gmail_attr">On Fri, Oct 9, 2026 at 9:53 AM Support &lt;support@supportseal.app&gt; wrote:</div>',
      '<blockquote class="gmail_quote"><div>thanks oldie</div></blockquote>',
      "</div>",
    ].join("");
    expect(stripKnownQuoteHtml(html)).toBe('<div dir="ltr">Here is my reply text</div>');
  });

  it("removes the Outlook web #appendonsend original", () => {
    const html = [
      "<div>Reply above</div>",
      '<div id="appendonsend"><hr><div>original email body</div></div>',
    ].join("");
    expect(stripKnownQuoteHtml(html)).toBe("<div>Reply above</div>");
  });

  it("removes the Outlook desktop #divRplyFwdMsg header and the original after it", () => {
    const html = [
      "<div>My reply</div>",
      '<div id="appendonsend"></div>',
      '<div id="divRplyFwdMsg"><b>From:</b> Support<br><b>Sent:</b> Friday, October 9, 2026 9:53 AM<br><b>To:</b> Customer<br><b>Subject:</b> Request</div>',
      "<div>Original email</div>",
    ].join("");
    expect(stripKnownQuoteHtml(html)).toBe("<div>My reply</div>");
  });

  it("keeps a #divRplyFwdMsg element whose content is not a From/Sent/To header", () => {
    const html = '<div>before</div><div id="divRplyFwdMsg">just body text, no labels</div><div>after</div>';
    expect(stripKnownQuoteHtml(html)).toBe(html);
  });

  it("keeps ambiguous HTML with no confident quote markers", () => {
    const html = "<div>Reply</div><div>Something that looks like an original but is unmarked</div>";
    expect(stripKnownQuoteHtml(html)).toBe(html);
  });

  it("keeps an unbalanced gmail_quote element (never guess the boundary)", () => {
    const html = '<div class="gmail_quote"><div>quote never closed';
    expect(stripKnownQuoteHtml(html)).toBe(html);
  });
});

describe("inboundBodyText (issue #128)", () => {
  it("uses the stripped text/plain part when present", () => {
    expect(
      inboundBodyText({
        text: "not sure how i feel about this\nOn 10/9/2026 9:53 AM, Support wrote:\n> thanks oldie",
        html: "<div>ignored</div>",
      }),
    ).toBe("not sure how i feel about this");
  });

  it("falls back to stripped HTML when text/plain is absent (Gmail shape)", () => {
    const html = [
      "<html><body>",
      '<div dir="ltr">Here is my reply text</div>',
      '<div class="gmail_quote"><div class="gmail_attr">On Fri, Oct 9, 2026 at 9:53 AM Support wrote:</div><blockquote>thanks oldie</blockquote></div>',
      "</body></html>",
    ].join("");
    expect(inboundBodyText({ text: null, html })).toBe("Here is my reply text");
  });

  it("falls back to stripped HTML when text/plain is absent (Outlook divRplyFwdMsg shape)", () => {
    const html = [
      "<div>My reply</div>",
      '<div id="appendonsend"></div>',
      '<div id="divRplyFwdMsg"><b>From:</b> Support<br><b>Sent:</b> Friday<br><b>To:</b> Customer<br><b>Subject:</b> Request</div>',
      "<div>Original email</div>",
    ].join("");
    expect(inboundBodyText({ text: null, html })).toBe("My reply");
  });

  it("keeps ambiguous HTML content but separates its paragraphs", () => {
    const html = "<div>Reply about the invoice</div><div>Original-looking but unmarked text</div>";
    expect(inboundBodyText({ text: null, html })).toBe(
      "Reply about the invoice\nOriginal-looking but unmarked text",
    );
  });

  it("applies the plain-text rules to unmarked HTML that converts with quoted lines", () => {
    const html = [
      "<div dir=\"ltr\">Reply text<br>On 10/9/2026 9:53 AM, Support wrote:<br>&gt; thanks oldie</div>",
    ].join("");
    expect(inboundBodyText({ text: null, html })).toBe("Reply text");
  });

  it("returns empty for a mail with neither part", () => {
    expect(inboundBodyText({ text: null, html: null })).toBe("");
    expect(inboundBodyText({ text: "   ", html: null })).toBe("");
  });
});
