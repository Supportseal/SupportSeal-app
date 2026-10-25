# Accessibility — V2 design

Status: design for a later build; no product implementation or claim of
conformance in this change. Based on current `origin/main` at `f45e21d`
(2026-10-01), including merged diagnostics. **Default** means a working
choice the maintainer can override, not a recorded approval. Questions are indexed in
[open-questions.md](../open-questions.md#accessibility-v2-design-2026-10-01).

## Goals and boundaries

**Default target: WCAG 2.2 Level AA**, including applicable Level A criteria,
for complete SupportSeal-controlled web journeys in hosted and self-hosted
modes. Keyboard and screen-reader users must be able to receive, find,
understand and answer a support request without pointer assistance. Preserve
the current information architecture, mint identity and compact inbox; fix
semantics, interaction and presentation rather than redesigning the product.

This is the accessibility slice in the [PRD Later sequence](../PRD.md#later-and-outside-scope):
diagnostics (merged), richer branding and presence, assignment and priority,
verified custom sending domains, accessibility, then analytics. Sequence is
not implementation status: the three intervening designs are separate work.
Agent avatars, presence and typing indicators remain deferred by branding
and are explicitly outside this document.

Non-goals: full redesign, new inbox workflows, custom themes or a dark widget,
AAA conformance, an accessibility overlay, automatic translation, analytics,
new auth/billing behaviour, and remediation of arbitrary customer attachments
or third-party sites. Do not change permission boundaries, delivery rules,
sender-domain verification, assignment or priority policy. No new database,
API or infrastructure is required by this design. Test-tool additions below
are proposals for the build, not dependencies installed by this docs change.

The target covers owned pages and complete processes, not just passing
components. Host websites, received email and uploaded files can contain
inaccessible content: keep owned controls accessible, document limits and
evaluate those dependencies before making any public conformance claim.
Email clients have their own rendering limits; owned email content has the
specific acceptance contract below rather than a blanket client guarantee.

## Relationship to requirements and designs

The [FRD](../FRD.md) remains canonical for functional behaviour. V1 keyboard
support in FR-CHAT-05 and the marketing site's existing AA commitment are
not postponed to V2. `AX-*` below are V2 design acceptance IDs, not invented
V1 FRD requirements. When building, reconcile affected design notes and
record shipped V2 behaviour in the requirements documentation together.

| Owner | Accessibility extension; contract retained |
| --- | --- |
| [support-inbox.md](support-inbox.md); FR-INBOX-01/02 | Preserve list/link semantics, filters, status and Product identity. Clarify keyboard defaults, realtime focus stability and return paths below. |
| [conversation-view.md](conversation-view.md); FR-INBOX-02/03, FR-EMAIL-03, FR-FILE-01 | Preserve reply/note separation, send keys, saved replies and pagination. Specify labels, announcements and failure recovery. |
| `marketing-site.md` (the private `supportseal-marketing` repository) | Retain its WCAG 2.2 AA baseline, responsive structure, copy and hosting-mode decisions; include every shipped route in the audit. |
| [brand.md](brand.md); FR-PROD-02 | Owns the app mint palette and `--vx-*` tokens. Measure rendered contrast; do not introduce a replacement palette. |
| [V2 branding design](https://github.com/Supportseal/SupportSeal-app/blob/8a67ca3cef58ae98ccf4c81f31e5ad47a43f3cd2/docs/design/branding.md) | Read from `design/branding` at this revision; absent from this main baseline. Keep its Product logo, greeting, corner, fallback and decorative-image rules. Apply this accessibility contract when those controls ship; do not copy its model or reopen its scope. |
| [chat-widget.md](chat-widget.md); FR-CHAT-01–05 | Preserve Shadow DOM launcher, iframe isolation, desktop non-modal/mobile modal distinction and Live/Away behaviour. Make the cross-document focus contract explicit. |
| [app-shell.md](app-shell.md), [onboarding.md](onboarding.md), [product-settings.md](product-settings.md); FR-ACC-01, FR-PROD-01 | Shared landmarks, form errors, menus and dialogs; no role or onboarding-policy changes. |
| [diagnostics.md](diagnostics.md); FR-CTX-01/02 | Include the shipped diagnostics notice, disclosure controls and context panel in the audit. Do not change capture, consent or retention policy. |
| FR-HOST-01, FR-SEC-01/02 | Same core accessibility in both hosting modes; labels, hidden text and live regions must not expose unauthorised data or internal notes to visitors. |

The unmerged assignment-priority and sender-domains designs retain ownership
of their features. Their eventual controls inherit these shared patterns;
their implementation is not a prerequisite for auditing today's main.

## Surface inventory

| Surface | Required coverage |
| --- | --- |
| Marketing | Home, features, pricing, self-hosting and any enabled legal pages; header/mobile navigation, footer, FAQ, comparison tables, screenshots, code-copy controls and theme switch. Give informative screenshots equivalent text/captions; decorative images have empty alt. |
| Auth and onboarding | Registration, sign-in, invitations and any shipped recovery/verification screens; labelled fields, password-manager/autofill and paste support, submission errors, loading and expired-link recovery. Keep security rules; do not add a cognitive test or block assistive input. |
| Workspace admin | Workspace/team, Products, channel settings, saved replies, Live/Away, usage and owned billing controls; read-only Agent states, validation, destructive confirmations, previews and copy actions. Include the hosted payment handoff in manual evaluation, without redesigning the provider. |
| Support inbox | All Products and one Product, status tabs, search/clear, empty/error/loading results, row identity, pagination, realtime additions and status changes. |
| Conversation | Header/actions, history, reply/note composer, channel choice, saved replies, attachments, tags, customer/context/diagnostics, narrow-screen sheets and send failures. |
| Widget | Launcher, open/close, live and away forms, optional email capture, attachments, diagnostics disclosure, resumed history, reconnect/error and unread states on a real embedding page. |
| Emails | Owned invitations, auth, usage notices and support replies that exist at build time. Preserve readable plain-text content, meaningful link text, logical order and attachment filenames; if an owned template emits HTML, include language, semantic structure, alt text and a useful plain-text alternative. No new branded email template is required. |

Inventory real routes/templates at build start, recording role, hosting mode,
theme and state. Do not count a V1 design mock-up as implemented coverage.
Received mail remains sanitised, remote images stay blocked by default, and
show-images/quoted-history/download actions remain keyboard accessible.
Do not fabricate descriptions for unknown images or enable unsafe HTML to
recover semantics; retain supplied safe alternatives and identify filenames.

## Keyboard and focus contract

### Shared navigation

- Use native links for navigation, buttons for actions and labelled form
  controls. No positive `tabindex`, clickable divs or hover-only actions.
  DOM, reading and focus order follow the visible task order across breakpoints.
- First focusable control on owned top-level pages is **Skip to main
  content**. Reveal it on focus and move focus to the main heading/container
  (`tabindex="-1"` when needed). The app also offers **Skip to conversations**
  and, when open, **Skip to reply**. Label navigation and main regions; give
  each route a descriptive title and primary heading.
- On intentional route navigation focus the destination heading; browser
  Back to the inbox restores the originating row and scroll when available.
  Search/filter updates retain focus on their initiating control. Validation,
  SSE events, theme changes and background refresh never steal focus.
- Show a visible focus outline, default 2 CSS px plus separation from the
  control. Keep the whole focused control visible where practical, including
  under sticky headers/composers. Independently scrolling panes must allow
  keyboard scrolling and never hide the focused item.
- Arrow keys/Home/End follow the existing Radix tab/menu/select patterns;
  Tab leaves a composite control. Tooltips work on focus, dismiss with Escape
  and contain no essential instruction unavailable elsewhere. Do not turn
  ordinary links into an ARIA application, grid or listbox.

### Inbox and conversation

**Default:** ordinary Tab/Shift+Tab through conversation links, Enter to
open, with native list semantics. This deliberately replaces V1's proposed
one-Tab-stop/roving-link requirement for V2: arrow-only discovery in a list of
links is not the baseline. Keep explicit Load more and Load earlier messages
buttons alongside automatic pagination; appended content must be reachable.

**Default:** single-character shortcuts (`j`, `k`, `/`, `r`, `n`, `e`) are
off until the user enables **Inbox keyboard shortcuts** in an accessible
help/settings control. Explain bindings and provide an off switch in the
same place. Store the preference locally per signed-in account/browser;
absence or storage failure means off, with feedback if a choice cannot be
saved. No server preference or migration is needed. If enabled, shortcuts
apply only inside the inbox, never while editing inputs, textareas,
contenteditable, comboboxes or dialogs, nor during IME composition. Every
shortcut has a visible control equivalent. No global host-page widget keys.

Opening a row focuses the conversation heading, not Send or the composer.
Back to inbox restores its row; if missing, use the next surviving row at
that position, then the preceding row, then the list heading. Escape returns
from the conversation to its row only when no nested control consumes it;
while editing, require the explicit Back action. Preserve drafts.

Realtime changes preserve the focused row by Conversation ID and do not
reorder it out from under the user. Queue disruptive list updates behind the
existing new-items affordance while focus is in the list or it is scrolled
away. If a row must disappear, use the fallback above and announce why.
A user status change retains focus on its action while the conversation
remains open; it does not silently open the next conversation. This clarifies
the older list design's “next row selected” wording for V2.

Agent composer: Enter inserts a newline; Ctrl/Command+Enter sends. Widget:
retain Enter to send and Shift+Enter for a newline, with visible key help and
a Send button. Neither sends during IME composition or while a picker owns
the key. Successful send retains composer focus; failure preserves the draft
and announces a retryable error. Saved-reply insertion (from `/` or the Saved button) returns focus/caret to
the composer and never sends. Removing an attachment returns focus to the
next remove action or Attach button. File picking is always an alternative
to drag-and-drop. Mode changes keep focus on the Reply/Note tab and update
the composer's label and delivery description.

### Dialogs, sheets and widget boundaries

Use the existing Radix dialog/sheet primitives for dashboard confirmations
and modal sheets. Give each a visible title, description where useful and
Close/Cancel control. Move focus inside on open; use the first meaningful
field, a heading for long content, or Cancel for destructive confirmation.
Trap Tab/Shift+Tab while modal, make the background inert, close the topmost
layer with Escape and return focus to its trigger. If the trigger disappeared,
focus the next logical action/heading. Existing dirty-draft confirmation
rules still apply. Never discard work solely because Escape was pressed.
See the [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

Widget-specific implementation contract:

- Give the iframe a title, “{Product} support chat”, and the panel a named
  dialog. Keep all label/description ID references in the same DOM tree;
  `aria-controls` on the Shadow DOM launcher may reference a wrapper in that
  shadow root, never an ID inside the iframe. Reflect open state with
  `aria-expanded`; do not rely on that relationship alone to convey purpose.
- Desktop is non-modal: no `aria-modal="true"` and no focus trap. On explicit
  open, focus the live composer or the first required Away field; after the
  last panel control, Tab can reach the host document, as can Shift+Tab at
  the beginning. Provide a visible Close control inside the iframe.
- Mobile full-screen is modal: initially focus its heading without opening
  the soft keyboard; constrain focus and assistive navigation to the panel.
  The loader must coordinate host-background inertness as well as the iframe
  boundary. Trapping Tab only inside the frame is insufficient. Preserve and
  restore any pre-existing host inert/scroll state; never hide an ancestor
  of the widget itself. Switching breakpoint while open updates modal state
  without resetting drafts or losing focus.
- Close or Escape (after inner popovers) requests closure from the loader
  and restores launcher focus. Closed iframe content is not tabbable or
  exposed to assistive navigation. SPA removal restores host state and uses
  the previous surviving host focus target if the launcher no longer exists.
- Coordinate focus with validated messages between loader and panel: check
  the expected source window and origin, use the known destination origin
  and add no broad host-document event interception. Reuse the existing
  trusted embedding relationship; do not loosen widget origin/session checks.
- Opening must be explicit. Incoming messages, restoration and reconnects
  never open the widget or move host focus. Test host elements before and
  after the embed, two launcher corners when branding ships, and host modals.

## Names, state and announcements

Visible labels are preferred; an accessible name includes the visible words
so speech input can identify the control. Icon-only buttons need action
names, not icon names. Decorative icons/logos are hidden when adjacent text
already identifies them. Do not duplicate names with both image alt and text.

| Control/content | Required accessible information |
| --- | --- |
| Inbox list and row | List: “Conversations, {Product scope}, {status or search results}”. Row link: contact, Product, channel, needs-reply/failure text when applicable, time and concise preview; retain the visible contact name. Current conversation uses `aria-current`. Avoid repeating decorative chips/icons. |
| Search/status/filter | Persistent “Search conversations” label; Clear search action; status names and counts, selected state; labelled Product scope picker. Loading/result counts are status updates, not focus moves. |
| Reply/note composer | “Reply to {contact}” or “Internal note”; associate delivery channel/recipient or “Only your team can see this” with `aria-describedby`. Buttons say Send reply/Add note; split-send menu has its own name. |
| Message/history | Author, message kind and readable timestamp; notes explicitly say Internal note. Delivery failure has text and a named Retry button. Expose an absolute timestamp without requiring hover. |
| Files, tags and context | “Attach a file”, “Remove attachment {filename}”, “Remove tag {name}”, “Copy {field}”. Name progress by filename, disclose expanded state and keep copy success/failure accessible. |
| Widget launcher | “Open chat with {Product}” / “Close chat with {Product}”, plus an accurate unread count when nonzero. Never include private content in the closed launcher's label. |
| Widget fields and notices | Visible Email/Message labels, required state, associated error/help text; named diagnostics disclosure with expanded state, and availability in words. |

Use a polite status region for results, save/send success, reconnect state and
new-message summaries. Announce actionable submission failures once with an
alert; keep a persistent inline error, linked with `aria-describedby` and
`aria-invalid`. On failed form submission focus the error summary (links to
fields), or the single invalid field. A timed toast is never the only route
to an error or recovery action.

Retain labelled history/log semantics, but announce only newly received
messages once. Initial history, older-page loading, optimistic echoes and
reconnect deduplication must not re-read the transcript. Implement one live
announcement path, not both a live log and duplicate live summary. **Default:**
announce a short incoming-message summary and leave full content navigable;
coalesce inbox count changes to at most one summary per 10 seconds. New
messages do not move focus or scroll a reader away from older content; a
New messages button moves to the new content only on activation. Notes never
enter visitor live regions. Closed-widget announcements contain counts only,
are similarly coalesced and do not interrupt host input.

## Contrast, themes, zoom and motion

Use [brand.md](brand.md#contrast-verification) as the token baseline, not as
proof of every rendered combination. Light primary is deep mint `#08765A`;
signature mint `#3DDC97` belongs on the intended dark/decorative surfaces,
not white text buttons on light backgrounds. Solid controls use contrast
tokens. Decorative divider tokens are not sufficient control boundaries.

Measure normal text at 4.5:1, large text at 3:1, and meaningful control/state
graphics against adjacent colours at 3:1. Large means at least 24 CSS px
regular or about 18.67 CSS px bold. Check light/dark, hover, active, selected,
error, placeholder, muted timestamp and composited translucent backgrounds.
Our focus-outline target is 3:1 against adjacent surfaces; the translucent
focus glow is supplementary, not the sole indicator. Distinguish current
selection from keyboard focus. Status and Product identity always include
words or another non-colour cue.

Product colours remain customer data, separate from app tokens. **Default:**
keep the stored colour; choose readable black/white foregrounds and use a
neutral contrasting border/focus outline where needed. Use the colour as an
accent rather than low-contrast body text. Do not reject existing colours,
silently rewrite saved branding or add new palette controls. Reuse the
branding logo/name fallbacks and check white, black, bright mint and mid-tone
Product colours in preview and the real widget.

Support 200% text resizing and reflow at 320 CSS px width (also exercise
400% desktop zoom), plus user text-spacing overrides without clipped labels,
lost controls or page-level horizontal scrolling. Keep necessary long-code
or genuinely two-dimensional data scrolling local, named and keyboard usable.
Use the existing narrow inbox layout when zoom requires it. Dialogs and the
mobile widget must scroll with the soft keyboard open; never disable zoom.

Minimum targets are 24 × 24 CSS px or meet the WCAG spacing exception;
**Default product target:** 44 × 44 for touch icon actions, widget controls
and new branding controls. Do not shrink existing larger targets. Honour
`prefers-reduced-motion` for panel transitions, skeletons and smooth scrolling;
state remains clear without animation. Check OS forced-colours mode: outlines,
selection and buttons remain identifiable without relying on background fills.
No new high-contrast theme is required. These are product requirements aligned
with [WCAG 2.2](https://www.w3.org/TR/WCAG22/), not an exhaustive conformance audit.

## Verification plan for the later build

### Automated

1. Inspect the effective ESLint config before adding rules. Main extends
   `eslint-config-next/core-web-vitals` and TypeScript; it does not directly
   declare `eslint-plugin-jsx-a11y`. Verify inherited coverage, then explicitly
   enable the plugin's recommended rules as needed without duplicate plugin
   registration. Map shared Button/Link/Input components accurately; enforce
   names, alt text, label associations and keyboard semantics. Narrow justified
   exceptions need an explanation; do not blanket-disable noisy rules. See
   [jsx-a11y documentation](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y).
2. Propose `@axe-core/playwright` as a development-only dependency in the
   implementation change; it is absent from this baseline. Use the existing
   Playwright suites, not a new runner/service. Scan applicable WCAG 2.0/2.1/2.2
   A/AA rules (including `wcag22aa`), plus review relevant best-practice results.
   Treat every applicable violation as a failure regardless of severity label.
   Review `incomplete` results manually. Track any external-content exclusion
   by rule, exact scope, reason and issue; excluded states are not passing
   coverage. See [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing).
3. Scan representative complete pages and interactive states: menus, dialogs,
   invalid forms, empty/results lists, reply/note, failed send, context disclosure,
   widget Live/Away/errors and both owned app themes. Exercise hosted Admin,
   Agent and self-hosted core flows. Reach states before scanning; a scan of
   a closed dialog says nothing about its contents.
4. The widget launcher uses Shadow DOM and the panel uses a cross-origin
   iframe; generated HTML/JS in `src/app/api/widget/{js,panel}/route.ts` is not
   covered like JSX. Scan the launcher and actual panel document explicitly,
   confirming the iframe was analysed rather than skipped. Use a controlled
   host fixture and dedicated panel execution when cross-origin injection
   needs it; do not weaken production isolation to make axe work.
5. Add Playwright assertions beyond axe: keyboard task completion, focus
   return, modal containment/desktop escape, accessible names and state,
   preserved drafts, IME send guards and realtime focus stability. Include
   semantic role/name locators. Test owned email output structurally and keep
   meaningful plain-text content; screenshots alone cannot test reading order.

Run existing lint/typecheck/unit-integration/build checks and the relevant
hosted/self-hosted E2E flows for the implementation. Keep test libraries out of
the shipped widget bundle and preserve its documented size budget. Do not
claim axe establishes conformance or add CI/verify scripts merely to match a
generic workflow; propose any CI policy change separately.

### Manual release evidence

**Default matrix:** NVDA with Firefox on Windows and VoiceOver with Safari
on macOS for desktop; VoiceOver with Safari on iOS and TalkBack with Chrome
on Android for the widget/mobile flows. Record actual browser, OS and reader
versions with each result. This is a minimum test matrix, not a promise that
other combinations are unsupported. Tool unavailability is a recorded gap,
not a pass or a reason to substitute an automated accessibility snapshot.

For each matrix entry, complete applicable keyboard/reader journeys: sign
in and recover from an error; filter/open a conversation; read earlier history;
reply and add a note; insert a saved reply; attach/remove a file; recover from
a send failure; open/close a context sheet. On a host page, open/close the
widget, chat, submit Away with validation, read a new reply and return to the
host. Test tab order, meaningful announcements, speech verbosity, visible
focus and mobile virtual-cursor escape. Also inspect zoom/text spacing,
contrast, reduced motion, forced colours and touch targets. Check sample
owned emails with images disabled and a reader in Gmail web and Outlook web;
add client coverage if the maintainer identifies a customer requirement.

Record route/state, configuration, result and evidence in the build review.
Automated checks cannot judge useful alt text, understandable errors, logical
reading order, live-announcement quality, every contrast state or usability.

## Acceptance criteria

These scenarios are the minimum implementation contract, not a substitute
for reviewing all applicable WCAG criteria across the inventory.

| ID | Observable acceptance |
| --- | --- |
| AX-01 | Every inventoried owned page has a meaningful title/heading, labelled landmarks and a working visible-on-focus skip link. Route navigation and browser Back put focus at the documented destination. |
| AX-02 | With shortcuts off and no pointer, an Agent can filter/search, open a row, load more/earlier content, reply, note, use saved replies, manage tags/files and change status. Shortcuts can be enabled/disabled without a shortcut; typing and IME never trigger them. |
| AX-03 | Inbox links announce contact/Product/channel/state and the current row. Realtime insertion, reorder, removal and reconnect preserve focus or use the specified fallback; no duplicate history announcement occurs. |
| AX-04 | Reply and Note announce distinct names/privacy/delivery context. Send keys follow each surface's convention; failure preserves the draft and provides a reachable Retry. Picker/attachment interactions restore a useful focus location. |
| AX-05 | Every modal has a name, appropriate initial focus, contained keyboard/reader navigation, Escape/Close and focus restoration. Nested layers close one at a time; destructive actions remain confirmable and drafts are not discarded by dismissal. |
| AX-06 | On a real host, the closed launcher is named and reachable; opening focuses the correct panel target. Desktop Tab can leave the non-modal panel. Mobile excludes host navigation while open and restores prior host state and launcher focus on close. Resize and SPA removal leave no trap. |
| AX-07 | Live and Away widget journeys, email validation, attachment use, diagnostics disclosure and service failure recovery work by keyboard and the mobile reader matrix. Announcements do not expose notes or move host focus. |
| AX-08 | Light/dark app states and light widget pass the specified measured contrast checks, including custom Product colour extremes. Focus and status remain clear in forced colours; logo fallback never removes the Product name. |
| AX-09 | At 320 CSS px, 200% text size, 400% desktop zoom and text-spacing overrides, essential content/actions remain reachable without overlap or page-level horizontal scrolling. Touch targets and reduced-motion behaviour meet the contract. |
| AX-10 | Auth/admin validation identifies and links errors without clearing valid input; paste/password managers work. Read-only/disabled states explain restrictions. Destructive and billing handoffs retain their existing safeguards. |
| AX-11 | Owned email samples retain useful plain text and meaningful links; any owned HTML passes structure/alt/contrast inspection and manual client checks. Inbound sanitisation, image blocking and attachment authorisation remain intact. |
| AX-12 | Effective JSX lint coverage and explicit axe scans pass for the documented state matrix, with every incomplete/excluded result accounted for. Manual reader evidence is recorded separately; missing evidence prevents claiming verified AA. |
| AX-13 | Hosted and self-hosted core journeys meet the same criteria; no accessibility dependency adds runtime telemetry or hosted services. Existing Workspace/visitor isolation checks still pass. |

## Defaults and open questions

Working defaults: WCAG 2.2 AA, shared accessible primitives without a redesign,
ordinary Tab navigation with opt-in inbox shortcuts, summary announcements,
unchanged widget send conventions and light theme, rendering fallbacks for
arbitrary Product colours, and the manual matrix above. These permit a later
build to proceed without asking the maintainer to choose individual ARIA attributes.

| ID | Decision for the maintainer | Working position and consequence |
| --- | --- | --- |
| AQ1 | Is an independent accessibility audit or published conformance report required before a public AA claim? | No external audit is commissioned and no public conformance claim is authorised by this design. Internal evidence can proceed; external spend and publication require the maintainer's decision. |
| AQ2 | Are there customer-required assistive technology/browser/email-client combinations beyond the default matrix? | **Default:** matrix above; record gaps explicitly. Additional contractual coverage needs the maintainer's input before promising support. |
| AQ3 | Should there be a public accessibility statement and dedicated feedback contact? | **Default:** retain existing support/contact routes without inventing an address, SLA or legal statement. The maintainer must choose ownership/contact and approve any public commitment. |

Track answers in [open-questions.md](../open-questions.md); then update this
document. None of these questions authorises a certification, new service or
changes to the separate branding, assignment or sending-domain designs.
