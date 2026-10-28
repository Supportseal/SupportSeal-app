# Chat widget — V1 design

Status: design direction for the build thread. Grounded in [PRD](../PRD.md)
(journeys 1, 4, 5), [FRD](../FRD.md) (FR-CHAT-01 to FR-CHAT-05, FR-CTX-01,
FR-CTX-02, FR-FILE-01, FR-PROD-02, FR-SEC-01, FR-SEC-02),
[architecture.md](../architecture.md) (separately bundled widget).

**UI kit baseline:** the widget must **not** import the dashboard React
components, the dashboard bundle, Tailwind output or the UI font (Plus Jakarta Sans)
(architecture.md: the widget never downloads the main application
JavaScript bundle). It reuses only token **values**, as its own
small CSS custom-property set written in px so it ignores the host's root
font size: the kit's radii (0.375/0.5rem → 6/8px) and the SupportSeal
**light-mode** neutral and status values from `brand.md` (surface
`#FFFFFF`, surface-2 `#EFF4F2`, heading `#15261F`, body `#43544D`, muted
`#5F6F69`, control border `#7A8B85`, danger `#C42B2B`, success `#1E7B34`).
The widget's accent is always the **Product** colour, never SupportSeal
mint. The panel follows the visitor's `prefers-color-scheme`: in dark mode it
uses the `brand.md` dark neutrals (surface `#16211D`, surface-2 `#111A17`,
heading `#E8F0EC`, body `#BDCBC5`, muted `#8FA19A`), with the control border
lifted to `#6B7D77` (3.8:1) and the Product colour unchanged (see
open-questions.md, "Widget visual refresh").

## Scope

Everything a visitor sees on a customer's site: loader, launcher, panel, live
chat, away form, email capture, attachments, resume, errors. Also the
preview mode used by onboarding and Product settings.

## Embed and isolation

- Embed: one async script tag carrying only the public Product key
  e.g. `<script async src="https://{host}/widget.js"
  data-key="pk_…"></script>`. No secrets (FR-CHAT-01).
- **Isolation** (FR-CHAT-05): the loader creates one fixed-position host
  element with a **Shadow DOM** for the launcher, and renders the panel in
  an **iframe** served from the SupportSeal origin. Host CSS can't reach
  either, widget CSS can't leak out, and the visitor session stays in the
  service origin's storage. The widget spike must confirm this split
  (partitioned storage, SPA behaviour); if it changes, the UX below still
  applies.
- **No layout shift**: all widget UI is `position: fixed` and injected after
  the host's load, so it reserves no space. No fonts are loaded; the widget
  uses the system stack `system-ui, -apple-system, "Segoe UI", Roboto,
  sans-serif`.
- **SPA survival**: the loader is idempotent (a second execution or
  duplicate tag is a no-op), re-attaches its host element if a framework
  removes it, and keeps panel state across `pushState`/`popstate`
  navigation.
- Stacking: host element `z-index: 2147483000`; never alters host `<body>`
  styles, scroll or focus unless the visitor opens the panel.

## Layout

### Launcher

- 56px circle, bottom-right, 20px from the viewport edges (16px on
  `< 640px`), respecting `env(safe-area-inset-*)`. Position is not
  configurable in V1.
- Fill: the Product primary colour. Icon (chat bubble; ✕ when open) in black
  or white, whichever contrasts better with the fill. The shadow uses the
  kit's menu shadow values.
- **Unread badge**: when an agent message arrives while the panel is
  closed, a small danger dot with a count, plus a one-line preview bubble
  above the launcher showing the first ~60 characters (dismissible, auto-hides
  after 8s). No sound in V1.
- Appears only after configuration loads successfully (see States). It
  never shows a broken launcher.

### Panel

- Desktop/tablet (`≥ 640px` wide): 380px wide, height `min(640px, 100vh -
  120px)`, anchored above the launcher, radius 16px, menu shadow.
  **Non-modal**: the host page stays usable.
- Mobile (`< 640px`): full screen (`100dvh`, safe-area padding), with
  `overscroll-behavior: contain` so scrolling doesn't chain to the host page.
  The launcher is hidden while open; a close button sits in the header.
- Open/close animation: 160ms opacity plus scale from the launcher corner;
  disabled under `prefers-reduced-motion`.

```
┌───────────────────────────────┐
│ Acme Analytics            ✕   │  header: Product colour, name, status
│ ● Online · Chat with us       │
├───────────────────────────────┤
│  (messages / away form)       │  scrolls
├───────────────────────────────┤
│ [clip] Write a message…  [➤]  │  composer
└───────────────────────────────┘
```

- **Header**: Product name (V1 branding = name plus colour only), background in the Product colour with auto-contrast text. Status
  line: live → success dot plus "Online · Chat with us"; away → muted dot
  plus "Away · Send us a message, we'll reply by email". On localhost, add a small "Test mode" pill so developers know
  they're on the development path (FR-CHAT-01).

## Modes

### Live (support available; FR-CHAT-02, FR-CHAT-03)

- First open, no Conversation: an empty thread with a neutral one-line
  prompt, "Ask us anything, we're here." (fixed copy; custom greetings are
  V2), and the composer focused on desktop (not on mobile, to avoid popping
  the keyboard).
- Composer: auto-growing textarea (1–5 lines, 16px font so iOS doesn't
  zoom). Enter sends, Shift+Enter inserts a newline (chat convention;
  differs from the dashboard on purpose). Attach button. Send button
  disabled when empty.
- Messages: visitor bubbles right, in the Product colour with auto-contrast
  text. Agent bubbles left, neutral: `#EFF4F2` with `#15261F` text
  (14.2:1), the SupportSeal light surface-2 and heading values from
  `brand.md`. The sender label is "{Product} Support", never the agent's
  name (*default*, see Decisions). Times on groups. Day separators.
- **Email capture (optional, FR-CHAT-04)**: after the visitor's first
  message, if no email is known (and none came from `identify`), insert an
  inline card in the thread: "Get replies by email if you leave", with an
  email input and Save button, dismissible ("No thanks"). Once saved, it
  collapses to "We'll email jane@example.com if you've left."
- Delivery state for visitor messages: sending (dimmed) → sent (none) →
  failed ("Not sent · Retry", text kept). "Seen" appears only if the
  service establishes read state (FR-CHAT-03).

### Away (support unavailable; FR-CHAT-04)

- The panel body is a short form: "Email" (required, `type="email"`,
  validated as a usable address before submit) and "Message" (required
  textarea), plus optional attachments. Button "Send message".
- After submit: the form becomes the thread with the visitor's message and
  a confirmation line: "Thanks, we'll reply to jane@example.com." The visitor
  may keep adding messages to the same Conversation.
- **Live → away mid-chat**: a system line "We're away now. We'll reply by
  email." If no email is known, the email capture card appears and becomes
  required before the next message sends.
- **Away → live**: the status line updates; no interruption.
- Availability is one **Workspace-wide** setting (maintainer, 2026-09-25), so all
  of a Workspace's Product widgets switch together. The widget receives it
  in its config and live updates.

### Resume (FR-CHAT-02)

- Same browser: reopening shows the existing Conversation, including agent
  replies sent while the visitor was away (their unread count shows on the
  launcher).
- The session token is unguessable and scoped to the Product and the exact
  embedding origin (scheme + host + port; issue #61); it is never shown in
  the UI or URLs. A credential issued on one origin never resumes on
  another — cookies and storage partition keys ignore ports, so the binding
  must not. Clearing the client's cookies and storage yields a fresh
  anonymous visitor (the away form is reachable again); `identify()`
  enriches the current session but never restores history by itself.
  Known limitation: within one schemeful site partition the widget cookie is
  a single slot shared by every embedding origin of a Product, so
  alternating between such origins (apex vs `www`) starts a fresh session on
  each hop — the later boot overwrites the earlier origin's credential. An
  http → https transition is a different partition entirely: each side keeps
  its own credential and session. Keying the credential by embedding origin
  is a possible follow-up.
- **Closed Conversation** (maintainer, 2026-09-25): if the visitor's Conversation
  was Closed, the thread still shows, and sending a message **reopens the
  same Conversation**. No new Conversation is created, and there is no
  "Start a new conversation" button in V1.

## Attachments (FR-FILE-01)

Attach button plus drag-and-drop onto the panel (desktop). Before upload,
check type and size client-side for fast feedback; the server re-checks.
Each file shows as a chip with progress and a remove (✕) button.
Rejections are inline: "This file type isn't supported" / "Files must be
under {limit}". Sent images show as thumbnails; other files as tiles.

## Developer context API (FR-CTX-01, FR-CTX-02)

No visible UI. `identify()` and `context()` update the session silently.
`reset()` ends the visitor session (issue #151, host sign-out): call it
when the user signs out of the embedding app so the next person on a shared
device never resumes their thread or identity. It revokes the session token
server-side (`DELETE /api/widget/session`), expires the widget cookie,
clears the panel's stored fallback token and open thread/drafts, and boots a
fresh anonymous visitor. `identify()` / `context()` calls made after
`reset()` apply to the fresh session; ones still queued from before it are
discarded. The previous visitor's conversation stays in the inbox. The same
call works through the async-safety queue: `q.push(["reset"])`; queue it
*before* awaiting the host's sign-out call, since a redirecting sign-out can
unload the page before code after the await runs.
The reset intent is also stored in the panel's partitioned `sessionStorage`
(`ss_reset_<key>`) the moment the panel receives it, and cleared only after
the revocation succeeds. If the host navigates away before the `DELETE` is
sent or answered (the usual sign-out redirect), the next page's boot in the
same tab revokes the old session first. Residual gap: a `reset()` that never
reached the panel (loader not yet loaded, or page unloaded before the message
was delivered) is not recoverable from the widget side. Likewise `reset()`
acts on the calling tab's panel only: another tab of the same host with the
widget open keeps its rendered thread and its already-open stream until it
reloads or the host calls `reset()` there too (cross-tab propagation and
stream revalidation against revoked tokens are a follow-up).
Identified name/email pre-fill the away form and suppress the email-capture
card. The widget never reads browser storage, form values or cookies of the
host page.

**Automatic page URL** (maintainer, 2026-09-25): the widget records the host
page URL itself, with no developer call needed. It records the URL when a
Conversation starts and with each visitor message, and on SPA navigation
it tracks `pushState`/`popstate` so the latest page is current. *Default:*
it records origin plus path only, with the query string and fragment
stripped, because those often carry reset tokens, emails or other secrets
(FR-SEC-02). Developers who want the full URL pass it via `context()`. The
dashboard shows it as "Page" in the context panel.

## Preview mode

For onboarding and Product settings, the same UI renders with a supplied
config (name, colour, live/away) and no network or session. Used for live
previews; clicking send shows a static example reply. It must be the real
component, not a mock-up, so previews stay truthful.

## States

| State | Behaviour |
| --- | --- |
| Config loading | Nothing visible (no launcher, no placeholder) |
| Invalid key / origin not allowed (FR-CHAT-01) | Render nothing. Log one concise `console.warn` naming the cause and the Product settings location; never expose other Products or data |
| Product archived | Render nothing (archiving prevents new interactions, FR-PROD-01; inbound email to the Product bounces); same console hint |
| Service unreachable at load | Retry with backoff (e.g. 2s, 10s, 30s) silently; show the launcher only once config loads |
| Service fails while panel open | In-panel `alert`: "We can't reach support right now." with Retry. Unsent text is kept. If away mode applies, suggest "Leave your email and we'll reply later." |
| Offline (`navigator.onLine` false) | Banner "You're offline. We'll send when you're back." Queued messages send on reconnect, deduplicated by client ID |
| Reconnecting stream | Subtle banner "Reconnecting…" after 3s; on reconnect, fetch from the last cursor (no duplicates, no gaps; FR-CHAT-03) |
| Message send failed | Bubble "Not sent · Retry" |
| Upload rejected / failed | Inline chip error with Retry for network failures |
| Conversation deleted (FR-SEC-02) | Session resets; the next open shows a fresh empty thread |
| Rate limited | "You're sending messages too quickly. Try again in a moment." |

## Responsive

- `< 640px`: full-screen panel, 44px minimum touch targets, safe-area
  insets, composer pinned above the keyboard using `100dvh` / VisualViewport.
- `≥ 640px`: floating panel. It fits in 360px-tall viewports by shrinking
  height (min 400px, then the panel scrolls).
- Landscape phones: full-screen, header reduced to 44px.
- Works on traditional multi-page sites (fresh load each page, session
  resumes) and SPAs (persistent host).

## Accessibility (FR-CHAT-05 keyboard use)

- Launcher: `<button>` with `aria-label="Open chat with {Product}"` /
  "Close chat", `aria-expanded`, `aria-controls`. Unread count in the label
  ("2 new messages").
- Panel: `role="dialog"`, `aria-label="{Product} support chat"`;
  `aria-modal="true"` only in mobile full-screen, where focus is trapped.
  On desktop it is non-modal: Tab moves naturally, and Esc closes and returns
  focus to the launcher.
- On open, focus moves to the composer (desktop) or the panel heading
  (mobile). On close, focus returns to the launcher.
- Thread: `role="log"`, `aria-live="polite"` for agent messages; system
  lines are announced once.
- Form fields have visible labels and inline errors linked by
  `aria-describedby`. Status (online/away) is text, not only a dot.
- Focus ring: 2px, using the Product colour when its contrast against the
  panel surface is ≥ 3:1, otherwise the neutral heading colour.
- Text contrast on Product-colour surfaces uses the black/white
  auto-contrast rule (whichever of black or white has the higher contrast
  ratio). The panel follows `prefers-color-scheme`.

## Not in V1

Logo/avatar, launcher position, custom greeting (V2) · launcher icon,
custom online/offline wording, required contact fields (V3) · arbitrary
custom CSS · typing indicators, agent presence/avatars (V2) · sound/desktop notifications · proactive or triggered messages ·
knowledge base, bots, AI answers (out) · automatic diagnostics, console or
network capture (V2 / out) · multiple concurrent Conversations per visitor
· conversation history list · emoji picker · message editing/deleting by
visitors · languages other than English.

## Decisions and defaults

See `docs/open-questions.md`, "Design decisions (2026-09-25)".
The maintainer's answers are marked (maintainer); *defaults* are maintainer-overridable.

- **Availability** (maintainer): Workspace-wide. Every Product widget in the
  Workspace is live or away together.
- **Closed Conversation** (maintainer): a visitor message reopens it; no new
  Conversation.
- **Page URL** (maintainer): recorded automatically. *Default:* origin plus path,
  no query or fragment.
- **Agent identity**: *default:* replies are labelled "{Product} Support";
  agent names and avatars are not shown to visitors.
- **Bundle budget**: *default:* loader script ≤ 5 KB gzip. Panel app (iframe)
  ≤ 50 KB gzip JS for first open, excluding images and attachments. Report
  both sizes in the widget PR; exceeding them needs an explicit
  justification.
- **Test page**: *default:* signed, single-Product, 30-minute test token
  (`onboarding.md`).

## Open points

- **Isolation approach**: Shadow DOM launcher plus iframe panel is proposed
  pending the widget spike (storage partitioning, CSP on host sites that
  restrict `frame-src`).
