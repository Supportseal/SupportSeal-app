# Conversation view — V1 design

Status: design direction for the build thread. Grounded in [PRD](../PRD.md)
(journeys 1, 3, 4, 5), [FRD](../FRD.md) (FR-INBOX-02, FR-INBOX-03,
FR-CHAT-03, FR-CHAT-04, FR-CTX-01, FR-CTX-02, FR-EMAIL-02, FR-EMAIL-03,
FR-FILE-01, FR-SEC-01, FR-SEC-02) .

**UI kit:** the in-repo kit (`src/components`, `src/styles/tokens.css`; paths below are relative to `src/`). Colours only via `--vx-*` tokens. `ProductMark`,
`ProductChip`, `Skeleton`, `EmptyState`, `Sheet`, `Popover` and `CopyButton`
are SupportSeal additions following kit conventions (Radix + `cva` +
`cn`).

## Scope

One Conversation: header and status, message thread (chat and email),
internal notes, composer with saved replies and attachments, and the
context panel (customer, developer context, attachments, tags). The list
and pane frame are in `support-inbox.md`.

## Layout

```
┌ Header ─────────────────────────────────────────────────────────────┐
│ [←] Contact label  [ProductChip] [chat][mail]   [Status ▾] [⋯] [▯]  │
├ Thread (scrolls) ─────────────────────────────────┬ Context (xl) ────┤
│            ── Tue 12 Mar ──                        │ Customer          │
│ ◖ customer chat bubble                             │ Developer context │
│                          agent chat bubble ◗       │ Tags              │
│ ▭ email card (From/To/Subject, sanitised body) ▭   │ Attachments       │
│ ▭ internal note (amber, lock) ▭                    │ Details           │
├ Composer ─────────────────────────────────────────┤                   │
│ [Reply | Note]                                     │                   │
│ textarea…                                          │                   │
│ [clip] [Saved] Sends via email to j@x.com [Send ▾] │                   │
└────────────────────────────────────────────────────┴──────────────────┘
```

### Header (h-14, `border-b`)

- Back arrow (only `< lg`), contact label (same priority as the list:
  identified name → email → "Visitor 4F2A"), `ProductChip`, channel icons.
- **Status control**: a button showing the current status (`Badge` colours
  Open=`primary`, Pending=`warning`, Closed=`secondary`) that opens a
  `DropdownMenu` (`components/ui/dropdown-menu.tsx`) with Open / Pending /
  Closed (FR-INBOX-02). Next to it, a one-click primary action: "Close"
  when Open or Pending, "Reopen" when Closed. After a change, show a toast
  with Undo.
- **Overflow `⋯`**: Copy conversation link, Copy Conversation ID, and
  Delete conversation (FR-SEC-02; **Admins only**, per the maintainer; Agents don't
  see the item and the server rejects the request). Delete uses a `Dialog`
  (`components/ui/dialog.tsx`) confirmation that states attachments are
  deleted too and that this cannot be undone.
- **Context toggle `▯`**: shown at `< xl`; opens the context panel in a
  right `Sheet`.

### Thread

- Messages are ordered oldest → newest, with day separators. The initial
  view anchors at the bottom (newest). Older messages load on scroll-up
  (cursor pagination, ~50 per page) with scroll position preserved, plus a
  "Load earlier messages" button at the top for keyboard users.
- **Chat messages**: bubbles with max width ~70ch. Customer: left,
  `bg-surface border border-border` (the thread sits on `--vx-body-bg`, so
  `--vx-surface-2` is too close to it in dark mode). Agent: right, `bg-primary-label`,
  text-heading, with the agent display name above the first bubble of a
  run. Group consecutive messages from the same author within 5 minutes and
  show a timestamp per group (absolute time on hover/focus).
- **Email messages**: full-width card (`border border-border rounded-lg`,
  not a bubble) with a header row: From, To, time, and the subject when it
  differs from the previous subject. The body is **server-sanitised** HTML
  (FR-EMAIL-03). Remote images are blocked by default with a "Show remote
  images" button, and quoted history is collapsed behind "…" (tracking/security). Plain-text parts render with preserved line
  breaks. Never render unsanitised mail HTML, and never with scripts.
- **Channel change**: a centred system line such as "Visitor left an email
  address, jane@example.com" or "Continued by email" when a chat continues
  by email (FR-INBOX-03, FR-EMAIL-02).
- **Internal notes** (FR-INBOX-02): full-width block, `bg-warning-label`,
  `IconLock`, label "Internal note: only your team can see this". Author
  and time are shown. Notes never look like customer-visible messages.
- **Message delivery state** (agent messages only; FR-CHAT-03, FR-EMAIL-03):
  - sending: 60% opacity with a small `Spinner`;
  - sent: no decoration (default);
  - delivered / read: show a subtle "Delivered" / "Seen" label **only if the
    service establishes that state**. Otherwise show nothing, and never fake
    it;
  - failed: danger text "Not delivered" with a **Retry** action and the
    provider reason if available. The Conversation row also shows the
    attention icon (support-inbox).
- **Attachments in messages** (FR-FILE-01): images as up to 240px
  thumbnails; other files as a file tile (type icon, name, size). Click
  opens the authorised download in a new tab. Files that failed safety
  checks show a muted "Attachment removed: {reason}" tile instead.
- **New messages while scrolled up**: a floating "New message ↓" pill;
  auto-scroll only when already at the bottom.
- **Realtime**: messages are written before they are broadcast (ADR-0003).
  The client de-duplicates by server message ID and by a client-generated
  ID on optimistic sends, so reconnects neither duplicate nor lose messages
  (FR-CHAT-03). On reconnect, fetch messages after the last known cursor.

### Composer

- Mode toggle **Reply | Note** (compact underline tabs, see support-inbox).
  Note mode switches the composer to `bg-warning-label` with the lock icon.
  The placeholder becomes "Add an internal note (not sent to the customer)"
  and the button "Add note". This visual switch is the main protection
  against leaking notes, so keep it prominent.
- **Text input**: plain `Textarea` (`components/ui/input.tsx` `Textarea`)
  that auto-grows from 3 to ~12 lines, then scrolls. **Do not use
  `components/ui/rich-editor.tsx`**: it relies on the deprecated
  `document.execCommand` and `dangerouslySetInnerHTML`. V1 replies are plain
  text with preserved line breaks; outbound email renders them as simple
  HTML server-side.
- **Delivery line**: states where a reply goes, e.g. "Sends via chat" or
  "Sends via email to jane@example.com as '{Product} Support'"
  (FR-EMAIL-02: managed sender that makes the Product clear). The channel
  is preselected by the default rule below; when both channels are
  possible, the line becomes a small select so the agent can override it.
  When neither is possible (anonymous visitor who left without an email),
  show a `warning` hint: "The visitor has left and gave no email. They'll
  see your reply if they return to the chat."
- **Reply channel rule** (*default*, see `docs/open-questions.md`):
  - Email-started Conversation → email.
  - Chat Conversation with the visitor's widget currently connected (a live
    stream or heartbeat within the last 60s) → chat.
  - Chat Conversation, visitor not connected, email known → email. The
    reply is also stored in the chat thread, so the visitor sees it if they
    return.
  - Chat Conversation, visitor not connected, no email → chat only (the
    warning above).
- **Closed Conversation**: a hint above Send, "Sending reopens this
  conversation" (maintainer: a reply to a Closed Conversation reopens it).
- **Send**: `Ctrl/⌘+Enter` sends; Enter inserts a newline. This avoids
  accidental email sends. The Send button is a split button
  (`components/ui/button.tsx` + `DropdownMenu`): **Send**, "Send and set
  Pending", "Send and close".
- **Saved replies** (FR-INBOX-02): one palette, two entry points, available
  in Reply mode only (not Note mode).
  - Typing `/` at the start of a line opens the palette above the
    composer. Focus stays in the textarea; the text after `/` is the live
    search query (no whitespace allowed in it, so `a/b` and URLs never
    trigger it). `↑`/`↓` move the highlight, `Enter` replaces the `/query`
    token with the reply, `Esc` closes without inserting. When nothing
    matches, Enter inserts a newline as usual.
  - The **Saved** toolbar button opens the same list in a `Popover` with a
    search field (focus starts there; same keys). Selecting inserts at the
    textarea's caret/selection.
  - Search matches name first (prefix, then substring), then body. Each row
    shows the name, its availability label ("All products" or the selected
    Product names) and a first-line preview.
  - **Availability**: a saved reply is available in All products or in a
    selection of one or several Products (FR-INBOX-02). The palette offers
    the All-products replies plus those whose selection includes the
    conversation's Product; other replies are never sent to the client for
    this conversation.
  - Insertion is editable text, never auto-sent; focus and caret return to
    the textarea after the inserted text. Empty state: "No saved replies yet"
    — Admins get a "Manage saved replies" link, Agents "Ask an admin to add
    some" (*default:* only Admins create, edit and delete saved replies; all
    roles insert them).
  - The management page (`/saved-replies`) shows each reply's availability,
    sorts All-products replies first then by Product names, and filters by
    scope (All; Workspace-wide = All-products replies only; one Product =
    any reply whose selection includes it). The create form's "Available
    in" field is an All-products / Product multi-select that defaults to
    All products. Replies that were Workspace-wide became All products;
    replies scoped to one Product kept that Product as their selection.
    Names stay unique per Workspace regardless of availability.
  - Admins can also save the current draft as a new reply from the composer
    (same "Available in" field); the draft is neither cleared nor sent.
- **Attachments**: paperclip button plus drag-and-drop onto the thread or
  composer (drop overlay with a dashed primary border, visual reference
  `components/ui/dropzone.tsx`, but a real upload without its demo copy).
  Each file becomes a chip with name, size, `Progress`
  (`components/ui/progress.tsx`) and remove (×). Type/size rejections show
  inline on the chip (FR-FILE-01). Send is disabled while uploads are in
  flight.
- **Draft**: unsent text and attachments persist per Conversation for the
  browser session (sessionStorage), so switching Conversations doesn't lose
  work.
- **Send failure**: the message stays in the thread as failed with Retry,
  and the composer text is never cleared on failure.

### Context panel (xl column / Sheet below xl)

Stacked collapsible sections (Radix Collapsible, as used in
`components/forms/layout-blocks.tsx`), each with a small uppercase heading
in the sidebar-section style (`text-[0.6875rem] tracking-[0.08em]
text-muted`):

1. **Customer**: `Avatar` (`components/ui/avatar.tsx`, initials), name,
   email (with `CopyButton`), "Identified by {Product} as user {id}" when
   `identify` was used (FR-CTX-01), otherwise "Anonymous visitor". Shows
   whether the email was supplied by the visitor, came from identify, or
   came from inbound mail. No other Products' history is shown here
   (FR-INBOX-03).
2. **Developer context** (FR-CTX-01/02), the differentiator:
   - Heading "Context from {Product}" with "updated {relative time}".
   - Well-known keys first, in this order when present: account, plan,
     app/build version, page URL, admin link. Then remaining keys
     alphabetically.
   - A `<dl>` grid of key/value rows. Values render as **text only** (no
     HTML, no Markdown). Long values truncate with expand. Nested objects
     render as indented collapsible groups, bounded by the server's depth
     limit.
   - Admin link: clickable only when it is an absolute `https:`/`http:` URL.
     Show the hostname beside it, open with `target="_blank"
     rel="noopener noreferrer nofollow"`. Anything else renders as text.
   - Page URL: the widget records it automatically (maintainer, 2026-09-25) as
     origin plus path, with query string and fragment stripped (*default*;
     `chat-widget.md`). Shown as "Page" (last page the visitor was on when
     messaging), labelled "recorded by widget". A developer-supplied page
     value from `context()` is shown as its own row. Text with copy; not
     auto-linked.
   - Every value row has a copy affordance on hover/focus.
   - Empty: "No context sent. Use `identify()` and `context()` in your app
     to see account details here," with a link to Product settings →
     Developer.
3. **Tags** (FR-INBOX-02): `TagInput` (`components/ui/tag-input.tsx`) with
   existing Workspace tags as `suggestions`; saves on change. Fix the
   theme gap: remove buttons need `aria-label="Remove tag {name}"`.
4. **Attachments**: all files in the Conversation, newest first, using the
   same tiles as the thread.
5. **Details**: created time, first channel, Conversation ID (copy),
   Product (chip).

## Components

| Need | Source | Notes |
| --- | --- | --- |
| Status badge / tags | `components/ui/badge.tsx` | `light` variant |
| Status + overflow menus, split send | `components/ui/dropdown-menu.tsx`, `components/ui/button.tsx` | |
| Composer | `components/ui/input.tsx` (`Textarea`) | Auto-grow; not `RichEditor` |
| Mode toggle | `components/ui/tabs.tsx` | `underline` `sm` variant |
| Saved replies palette | `saved-reply-palette.tsx` (shared filter + key handling) + Radix `Popover` for the Saved button | `cmdk` is not used: the `/` entry point keeps focus in the textarea, which cmdk cannot drive |
| Upload progress | `components/ui/progress.tsx` | |
| Tags | `components/ui/tag-input.tsx` | Add aria-labels |
| Avatar | `components/ui/avatar.tsx` | |
| Collapsible sections | `@radix-ui/react-collapsible` (see `components/forms/layout-blocks.tsx`) | |
| Confirm delete | `components/ui/dialog.tsx` | |
| Inline errors | `components/ui/alert.tsx` | |
| Loading | `components/ui/spinner.tsx`, new `Skeleton` | |
| Copy | new `CopyButton` | idle → "Copied" (2.5s) → idle; "Copy failed" on clipboard error (pattern: healthprovider `SupportEmailCopyButton`) |

## States

| State | Behaviour |
| --- | --- |
| Loading | Header skeleton plus 4 alternating bubble skeletons; composer disabled |
| Not found / no access | One identical `EmptyState` "Conversation not found" with "Back to inbox". Don't distinguish "exists in another Workspace" (FR-SEC-01) |
| Load error | `Alert` danger "Couldn't load this conversation" with Retry |
| Empty thread (email with no body) | Card shows "(no text content)" and its attachments |
| Closed | Header shows Closed. Composer stays available with the hint "Sending reopens this conversation"; a customer reply also reopens it live (status control updates, toast "Reopened by customer reply") |
| Archived Product | Composer replaced by an `Alert` secondary: "{Product} is archived. Incoming email bounces and new chats are blocked. Unarchive it to reply." Admins get an Unarchive button; Agents see "Ask an admin to unarchive it". Notes, tags and status changes still work (*default*) |
| Realtime disconnected | Thin inline notice above the composer, "Reconnecting… your replies still send". Sending continues over HTTP |
| Visitor email captured mid-chat | System line in the thread; Customer section updates live |
| Outbound email failed | Failed message state with Retry and reason |
| Deleted by an Admin while open | Replace view with `EmptyState` "This conversation was deleted" |
| Status changed by another agent | Status control updates live, with a quiet toast "Closed by Sam" |

## Responsive

- `xl`: thread plus context column (20rem). `lg`: thread only; context in a
  right `Sheet` (w-[22rem]). `< lg`: full-screen page with a back arrow;
  context in a full-height `Sheet`.
- Composer is sticky at the bottom of the pane, and uses `100dvh` so mobile
  browser chrome and the on-screen keyboard don't hide it. On `< sm` the
  toolbar collapses to icon buttons and the split-send menu stays
  reachable.
- Bubbles cap at 85% width on `< sm`.

## Accessibility

- Thread: `role="log"` with `aria-live="polite"` for **incoming** messages
  only. Each message is an `<article>` with an accessible label "{author},
  {time}"; notes are labelled "Internal note by {author}".
- Composer: visible label (visually hidden is fine) that changes with mode
  ("Reply to Jane via email" / "Internal note"). The mode is also announced
  when toggled.
- Shortcuts (only when focus is not in a text field unless stated): `r`
  focus reply, `n` focus note mode, `Ctrl/⌘+Enter` send (in composer), `e`
  close / reopen, Esc returns focus to the inbox list.
- Delivery state and failure are text, not icon-only. Retry is a real
  `<button>`.
- The palette is a listbox of `option`s. In the `/` entry point the textarea
  becomes a combobox (`aria-controls`, `aria-activedescendant`) while the
  palette is open; in the Saved popover the search field is the combobox.
  Esc closes it and returns focus to the textarea.
- Email body images get `alt` from the mail when present; blocked images
  show a text placeholder.

## Not in V1

Typing indicators and agent presence (V2) · assignment, priority, collision
detection (V2) · rich-text/Markdown composer · saved-reply variables and
placeholders · AI suggested replies · automatic browser diagnostics,
console/error capture, session replay (V2 / out) · merge/split
Conversations · cross-Product Contact history · custom
sender domains (V2) · per-message reactions or edits · forwarding a
Conversation.

## Decisions and defaults

See `docs/open-questions.md`, "Design decisions (2026-09-25)".
The maintainer's answers are marked (maintainer); *defaults* are maintainer-overridable.

- **Reopen** (maintainer): a customer or agent reply to a Closed Conversation
  reopens it; no new Conversation; not counted again for billing.
- **Delete** (maintainer): only Admins delete Conversations.
- **Page URL** (maintainer): recorded automatically by the widget. *Default:*
  origin plus path only.
- **Reply channel**: *default* rule in the Composer section.
- **Agent name to customers**: *default:* customers see "{Product} Support"
  in the widget and as the email sender name, never the agent's name. The
  dashboard still shows which agent wrote each reply.
- **Saved replies**: *default:* Admins manage, everyone inserts.
- **Archived Product**: inbound email bounces (maintainer). *Default:* the
  composer is disabled until the Product is unarchived.

## Open points

- **Delivered/read availability**: depends on the realtime spike (ADR-0003)
  and email provider events (ADR-0004); the UI shows nothing until the
  service can establish the state.
