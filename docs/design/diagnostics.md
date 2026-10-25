# Browser diagnostics — V2 design

Status: design direction for a later build thread. **V2, not V1**: nothing
here changes V1 behaviour or blocks a V1 release.
Grounded in [PRD](../PRD.md)
("Later and outside scope", principle "intentional context without
automatic collection of sensitive application data"); [FRD](../FRD.md)
(FR-CHAT-01, FR-CHAT-02, FR-CTX-01, FR-CTX-02, FR-HOST-01, FR-SEC-01,
FR-SEC-02); [chat-widget.md](chat-widget.md),
[conversation-view.md](conversation-view.md) and
[product-settings.md](product-settings.md) (their "Not in V1" notes); and
the draft legal pages (`src/content/legal/` in the private `supportseal-marketing` repository) (privacy, data
responsibility, acceptable use).

Items marked *default* are working choices the maintainer can override. Real
decisions for the maintainer are under [Open questions](#open-questions).

## Scope

When an Admin explicitly enables it for a Product, the widget collects a
small, redacted snapshot of technical problems on the visitor's page and
attaches it to the visitor's next message, so an agent sees "what broke"
beside the Conversation. This slice covers:

- the per-Product switch (off by default) in Product settings;
- the in-page collector and what it may and may never read;
- redaction, enforced in the browser and again on the server;
- storage, attachment to Messages, size bounds and retention;
- the agent-facing display;
- visitor disclosure hooks (the text itself is legal's, not this doc's).

It deliberately reuses the developer-context ownership boundary: the same
widget origin checks, visitor session, Product scoping and "untrusted
data, rendered as text" rules as `identify()` / `context()`
(`src/app/api/widget/context/route.ts`, `src/lib/dev-context.ts`).

## Principles

1. **Off unless an Admin turns it on**, per Product. No
   Workspace-wide or instance-wide default-on.
2. **Nothing leaves the browser unless the visitor sends a message.**
   Events wait in an in-memory buffer, and diagnostics never create a
   Conversation.
3. **Allowlist, not blocklist.** The collector reads only the fields listed
   under [What is captured](#what-is-captured). Redaction is a second line
   of defence for secrets that end up inside those fields (error messages,
   URLs), not permission to read more.
4. **The server is authoritative.** Everything from the host page is
   untrusted (the host page can run any script). The server re-validates,
   re-redacts and bounds every snapshot, exactly like developer context.
5. **Same behaviour hosted and self-hosted.** Snapshots go only to the
   installation serving the widget. No third-party error service and no
   telemetry to SupportSeal (FR-HOST-01).

## Enabling it (Product settings)

Lives on the Product's **Developer** tab (`product-settings.md`), below the
`identify()` / `context()` examples, because it is developer-facing and
shares that tab's "what reaches your team" framing. Admin-only, like all
Product settings; the server enforces the role.

```
Browser diagnostics                                   [ Off  ◯ ]
Attach JavaScript errors, warnings and failed network requests from the
visitor's page to their messages. Off by default.
What's collected · What's never collected · Your disclosure duties
```

- **Switch** (`components/ui/switch.tsx`), part of the Developer tab's
  form with explicit Save and the sticky save bar.
- **Turning on** opens a confirm `Dialog` before saving. It lists what is
  collected and what is never collected (the two lists below, verbatim),
  and states that the Admin's own privacy notice must tell their visitors.
  Hosted mode links to the Privacy Policy and the Hosted and self-hosted
  data responsibility page on the marketing site (`/legal/privacy`,
  `/legal/data-responsibility`, absolute links via `appConfig.marketingUrl`).
  The app itself no longer serves `/legal` in any mode (the pages moved to
  [supportseal-marketing](https://github.com/supportseal-marketing)
  with the rest of the marketing site), and
  those pages don't apply to operators, so self-hosted mode instead states
  that the operator is
  responsible for their own notices and links to the self-hosting guide
  (`siteConfig.selfHostingGuideUrl`). Button "Enable diagnostics". Wording of the duty sentence comes from
  legal review (see [Disclosure](#visitor-disclosure-and-consent)).
- **Turning off** saves immediately (no dialog). The server rejects new
  snapshots for that Product at once; widgets stop collecting on their next
  config load. Existing snapshots stay until they expire.
- **Delete collected diagnostics** (secondary, danger-styled button under
  the switch, shown when any exist): a confirm `Dialog` deletes every
  snapshot for this Product. Messages are untouched.
- Shows "Enabled by {Admin} on {date}" when on.
- Archived Product: the switch is visible but disabled, like the other
  archived-Product settings.

Data: `Product.diagnosticsEnabledAt DateTime?` and
`Product.diagnosticsEnabledById String?` (null = off). A timestamp rather
than a boolean records when disclosure duties began.

## Architecture

```
host page                              service origin
┌───────────────────────────────┐      ┌───────────────────────────────┐
│ widget.js loader              │      │ /api/widget/config            │
│   config.diagnostics === true │◀─────│   diagnostics flag            │
│   → load diagnostics.js       │      │                               │
│ diagnostics.js collector      │      │ panel iframe                  │
│   in-memory ring buffer       │ post │   on send: ask loader for     │
│   redacts before buffering    │◀────▶│   snapshot (250 ms timeout)   │
│                               │ Msg  │   POST /api/widget/messages   │
└───────────────────────────────┘      │   { body, pageUrl,            │
                                       │     attachmentIds, diagnostics}│
                                       │ server: gates → validate →    │
                                       │   re-redact → bound → store   │
                                       └───────────────────────────────┘
```

- **Config**: `/api/widget/config` adds `diagnostics: true` only when the
  Product is enabled and not archived. Absent means off.
- **Separate collector bundle**: the loader fetches
  `{serviceOrigin}/widget-diagnostics.js` only when the flag is true, so
  disabled Products run no capture code and the loader stays within its
  ≤ 5 KB gzip budget (D10). *Default* collector budget: ≤ 4 KB gzip,
  reported in the build PR like the widget budgets.
- **Start timing**: the collector starts after config loads, so errors
  thrown before that (early page load) are not seen. Capturing earlier
  would need an inline snippet ahead of the site's own scripts; out of
  scope for this slice.
- **Transport**: when the visitor sends a message (live chat or away form),
  the panel posts `ss:diag-request` to the loader and waits up to 250 ms
  for `ss:diag-snapshot`. No reply, or an empty buffer, sends the message
  without diagnostics. **Diagnostics never block a message, and never add
  more than that 250 ms wait.**
  Message checks follow the existing loader/panel pattern: the loader
  accepts `ss:diag-request` only when `event.origin === serviceOrigin`,
  and posts the snapshot with `targetOrigin` set to `serviceOrigin`, so
  only the panel can receive it. The panel accepts `ss:diag-snapshot`
  only when `event.source === window.parent` (the host origin varies, so
  it can't match on origin). The request itself carries no data.
- **Ingestion**: the optional `diagnostics` field rides on the existing
  `POST /api/widget/messages` request, behind that route's existing gates
  (widget request origin, Product key, domain allowlist, rate limit,
  visitor session, session origin match). In addition the server checks
  that the Product has diagnostics enabled *now*. The snapshot is stored
  in the same transaction as the Message it belongs to.
- **Invalid or oversized diagnostics never reject the message.** The
  Message is stored, the snapshot is dropped, and the response says so
  (`diagnostics: "rejected"` with a reason code such as `disabled`,
  `too_large`, `invalid` or `limit`). The server logs the reason code and
  Product ID only, never snapshot content.
- **Developer runtime switch**: `SupportSealWidget.diagnostics(false)`
  pauses collection and clears the buffer; `diagnostics(true)` resumes. It
  is handled in the host-page loader, where the collector lives, and is
  not forwarded to the panel. Like `identify()` / `context()` it is also
  accepted through the pre-load `SupportSealWidget.q` queue; the loader
  remembers the latest value and applies it when the collector starts, so
  a pause issued before the collector loads still holds. It can only narrow
  what the Product setting allows, never enable a disabled Product. This
  is the hook a site's own consent manager uses.

## What is captured

All fields below, and only these. Every string passes the
[redaction rules](#redaction) before it enters the buffer.

| Kind | Fields | Source |
| --- | --- | --- |
| JavaScript error | `name`, `message`, `stack` (parsed to at most 20 frames of function name, file URL, line, column), page path at the time, timestamp, repeat count | `window` `error` event (`event.error`, or `event.message` and location when no Error object) |
| Unhandled promise rejection | as above when the reason is an `Error`; a redacted string when it's a string; otherwise just the type (`"[non-error rejection: object]"`) | `window` `unhandledrejection` |
| Warning | first 5 arguments of `console.warn` and `console.error`: primitives (strings, numbers and booleans) as text; an `Error` as `name: message`; anything else as `[object]` | a narrow wrapper on `console.warn` and `console.error` only (*default*, see [Q3](#open-questions)) |
| Network failure | method, URL, status (`0` when the request failed without a response), timestamp, repeat count | wrappers on `fetch` and `XMLHttpRequest` that look only at method, URL and final status |
| Environment (one per snapshot) | page URL (origin plus path), viewport width × height in CSS px, device pixel ratio, application version | collector plus the visitor's stored developer context |
| Browser and OS (one per snapshot) | browser family and major version; OS family and major version | parsed **server-side** from the message request's `User-Agent` header. The raw string is not stored |

Details:

- **Network failure** means status ≥ 400 or no response. Requests to the
  widget's service origin are excluded, which avoids feedback loops.
  Aborted requests (`AbortError`) are excluded as normal app behaviour.
  Failed resource loads (`<img>`, `<script>` tags) are excluded in this
  slice.
- **Page URL** uses the D9a rule already used for the recorded page:
  origin plus path, no user info, query or fragment. The same reduction
  applies to every URL in a snapshot that parses, including network URLs
  and stack-frame file URLs (see [Redaction](#redaction)).
- **Application version** is the `appVersion` (or `buildVersion`/`version`)
  key from the visitor's existing developer context, copied into the
  snapshot at attach time so later `context()` calls don't rewrite
  history. If none is set, the snapshot shows "Not provided". There is no
  new version API.
- **Wrappers** keep the host page's behaviour intact: they call the
  original first, preserve `this` and arguments, and return the original
  result or promise unchanged. They never throw. Any collector failure is
  caught inside the collector and disables the collector for the rest of
  the page load. They never clone, read or wait on a request or response
  body, and never touch headers.
- **Error objects** are read for `name`, `message` and `stack` only. The
  collector never enumerates an error's other properties, because library
  errors often carry request config, headers or response data (e.g.
  `error.config`, `error.response`). It never calls `JSON.stringify` on
  captured values.

## Hard bans

The collector never reads, and the server never stores:

- cookies (`document.cookie`, `Cookie`/`Set-Cookie` headers);
- request or response headers of any kind, including `Authorization`;
- bearer tokens, access tokens, session tokens, API keys and secrets;
- passwords;
- payment details;
- request and response bodies;
- form values or DOM input contents (`input.value`, `FormData`, selection
  or clipboard);
- `localStorage`, `sessionStorage`, IndexedDB and Cache Storage;
- `console.log`, `console.info` and `console.debug` output;
- DOM content, screenshots or user interaction events.

The collector writes nothing to browser storage either: its buffer lives
in memory for one page load (SPA navigation keeps it; a full page load
resets it).

### How the bans are enforced

1. **Structure**: the collector has no code path to banned sources. The
   wrappers receive only method, URL and status by construction.
2. **Static gate (CI test)**: a unit test scans the collector's shipped
   source for banned identifiers (`document.cookie`, `localStorage`,
   `sessionStorage`, `indexedDB`, `caches`, `.headers`, `getAllResponseHeaders`,
   `getResponseHeader`, `.clone(`, `.json(`, `.text(`, `.blob(`,
   `.arrayBuffer(`, `.formData(`, `FormData`, `.value`, `JSON.stringify`,
   `console.log`, `console.info`, `console.debug` hooks) and fails on any
   match. Adding a banned read then requires deliberately changing the
   test, which a reviewer sees. (Snapshots cross to the panel by
   `postMessage` structured clone, and the client size check is an
   escape-aware string-length estimate (see [Size bounds](#size-bounds)),
   so the collector needs neither `JSON.stringify` nor `.value`.)
3. **Redaction** in the browser before buffering and **again on the
   server** before storage, using the same rule set and fixture corpus.
4. **Schema validation** on the server: unknown fields are dropped, types
   and lengths are checked, and only the fields in the capture table are
   persisted.

## Redaction

Rules live in one pure module (*default* `src/lib/diagnostics/redact.ts`)
used by the server. The collector ships an equivalent copy (it is a plain
JS bundle, like the loader). A **parity test** runs the same fixture corpus
through both and requires identical output, so they cannot drift.

Applied in this order to every captured string:

| Rule | Replacement |
| --- | --- |
| In a field, message or stack, a URL that parses keeps origin plus path; user info, query and fragment are dropped. Text that does not parse as a URL is unchanged by this rule. Later rules still apply | `https://u:p@app.example.com/reports?t=abc#x` → `https://app.example.com/reports` |
| `Bearer …`, `Basic …`, `Authorization: …` | `Bearer [redacted]` |
| JWT-shaped values (three base64url parts separated by dots, first starting `eyJ`) | `[token]` |
| `key=value` / `key: value` / `"key":"value"` where the key matches `password`, `passwd`, `pwd`, `secret`, `token`, `api[_-]?key`, `access[_-]?key`, `auth`, `session`, `cookie`, `card`, `cvv`, `cvc`, `iban`, `ssn` (case-insensitive, also inside compound keys like `x-api-key`) | `key=[redacted]` |
| Email addresses | `[email]` |
| 13–19 digit sequences (spaces/dashes allowed) that pass a Luhn check | `[card]` |
| High-entropy tokens: ≥ 32 hex characters, or ≥ 24 characters of `[A-Za-z0-9_-]` mixing letters and digits (this also covers UUIDs and most provider keys) | `[token]` |
| URL path segments matching the email, token or UUID rules | `/reset/[token]` |

Then strip control characters other than newline and tab (they would
inflate serialized size and can confuse display), and truncate: messages
500 characters, each stack 20 frames and 2,000 characters, each URL 300
characters (the existing page-URL cap).

Redaction favours over-redaction: a mangled order ID is a small support
cost; a leaked reset token is a security incident. Rules are tested with a
positive and a negative fixture each, including values seen in real
libraries (Stripe `sk_live_…`, GitHub `ghp_…`, AWS `AKIA…`, Supabase and
Firebase JWTs, Axios error messages that embed URLs).

## Size bounds

*Defaults*, all enforced on the client and again on the server:

| Bound | Value |
| --- | --- |
| Buffer | last 50 distinct events per page load, oldest dropped first |
| Deduplication | same kind + message + top stack frame (or method + URL + status) collapse into one event with a count and first/last seen |
| Window | only events from the last 30 minutes before the message are attached |
| Snapshot size | ≤ 32 KB serialized, measured by the server (authoritative). The client can't serialize (see the ban gate), so it trims oldest events until an escape-aware estimate is ≤ 24 KB: for each string, count every `"` or `\` as two characters (JSON escaping) and every other character as one, then add 128 bytes per event for keys and punctuation. The server, if a payload still exceeds 32 KB after re-redaction, trims oldest events to fit before storing; it only rejects (`too_large`) when even a single remaining event cannot fit |
| Per message | at most one snapshot. After the first message of a page load, later snapshots carry only events not already sent, and are skipped when there are none |
| Per Conversation | at most 100 snapshots; further ones are rejected (`limit`) |
| Rate | covered by the existing widget IP rate limit and per-message rule; no separate diagnostics endpoint exists to abuse |

Each stored snapshot records how many events were dropped or trimmed, so
the agent sees "12 more events not included" rather than a silently
partial picture.

## Storage and attachment

A new table, one row per snapshot, owned by exactly one customer Message:

```
DiagnosticSnapshot
  id, workspaceId, productId, conversationId,
  messageId      (unique; FK → Message, onDelete: Cascade)
  schemaVersion  Int
  environment    Json   (pageUrl, viewport, dpr, appVersion, browser, os)
  events         Json   (redacted, bounded array)
  errorCount, warningCount, networkFailureCount, droppedCount  Int
  createdAt, expiresAt
  @@index([workspaceId, conversationId])
  @@index([productId, expiresAt])
```

- `workspaceId` and `productId` are copied from the Message's
  Conversation at insert time. Every read filters by the caller's
  Workspace (FR-SEC-01, ADR-0001), with the same "not found" response for
  another Workspace's IDs as Conversations.
- Deleting a Message, Conversation, Product or Workspace cascades to its
  snapshots (FR-SEC-02). Contact deletion follows through the
  Conversation cascade.
- Only `CUSTOMER` messages from a widget visitor carry snapshots. Email
  messages, agent replies and notes never do.
- Snapshots are **internal**: never returned by visitor endpoints, never
  shown in the widget thread, never included in outbound email or any
  customer-facing transcript.

## Retention

- *Default*: **30 days** from capture (`expiresAt`), fixed in this slice.
  Configurable retention is part of the separate V2 retention-policies
  work which can later take over this value.
- Expired snapshots are **never shown**: every read filters on
  `expiresAt > now`.
- Physical deletion without new infrastructure: each snapshot insert also
  deletes up to 100 expired snapshots for the same Product (bounded,
  indexed by `[productId, expiresAt]`). Products that stop receiving
  messages keep expired rows (hidden) until a scheduled purge exists. See
  [Q4](#open-questions).
- The Admin "Delete collected diagnostics" action and Product/Conversation
  deletion remove data immediately regardless of expiry.

## Agent view (Conversation)

Extends `conversation-view.md`. Agents and Admins who can see the
Conversation can see its diagnostics (*default*).

- **Message chip**: a customer message with a snapshot shows a small
  secondary chip under the bubble, "Diagnostics · 2 errors · 1 failed
  request" (zero counts omitted; "Diagnostics · no errors" when only the
  environment was sent). Activating it opens a right `Sheet` with that
  snapshot.
- **Context panel section** "Diagnostics", placed after "Developer
  context": the latest unexpired snapshot's environment as a `<dl>`
  (Browser, OS, Viewport, App version, Page), counts, and "Captured with
  message at {time}". Below that, a list of earlier snapshots in this
  Conversation, each opening the same `Sheet`.
- **Snapshot `Sheet`**: environment block, then events newest first, each
  with kind badge (Error `danger`, Warning `warning`, Network `secondary`),
  message or "GET /api/reports → 500", time relative to the message
  ("40 s before"), repeat count, and stack in a collapsible `<pre>`
  (mono, horizontal scroll, `tabindex="0"`). A footer states the redaction
  notice: "Values that look like secrets, emails or tokens were removed."
  **Copy as text** (`CopyButton`) produces a plain-text block for pasting
  into an issue tracker.
- **Rendering**: text only, exactly like developer context. No HTML, no
  Markdown, no auto-linking (including stack file URLs), so hostile error
  messages can't inject markup.
- **Empty and absent states**: diagnostics off for the Product → the
  section is hidden. On, but nothing attached yet → "No diagnostics yet.
  They're attached when the visitor sends a message." Expired → "Diagnostics
  from this conversation have expired (kept 30 days)."
- **Accessibility**: the chip is a `<button>` with a full label
  ("Diagnostics for this message: 2 errors, 1 failed request"). Kind is
  text, not colour alone. The `Sheet` traps focus and returns it to the
  chip.

## Visitor disclosure and consent

This doc sets hooks, not policy text. Wording and the legal basis belong
to legal review (drafts are not legal advice).

- **Customer's duty**: the draft data-responsibility page already makes
  the customer responsible for "telling them how their information is
  handled" and for "what your applications send". The enable dialog
  repeats this and links there. SupportSeal does not decide on the
  customer's behalf whether their jurisdiction requires notice or consent.
- **Widget notice** (*default*): while diagnostics are enabled, the panel
  shows one muted line above the composer and on the away form, with a
  link that expands the "what is collected" list. Placeholder copy for
  the build: "Technical details from this page are shared with {Product}
  support." The final wording is set in legal review and the copy pass,
  not in the build thread.
- **Consent hook**: `SupportSealWidget.diagnostics(false|true)` lets a
  site's consent manager pause collection. Whether SupportSeal should also
  offer a "wait for consent" mode or a visitor-facing opt-out is
  [Q1](#open-questions).
- **Legal drafts to update before shipping** (hosted): the Privacy
  Policy's "Customer Data we process for customers" list
  (`src/content/legal/privacy.ts`, marketing repository) must gain a diagnostics item, and the
  Subprocessors page must be checked (no new subprocessor is expected,
  since data stays on the existing hosting). The Acceptable Use Policy's
  "Sensitive data" section already applies: redaction reduces risk but does
  not make it acceptable for an app to put secrets in error messages.
  These edits go through the legal-review process, not the build PR.
- **Marketing**: `docs/marketing/shipped-features.md` (marketing repository) currently states
  "No automatic logs, network capture, session replay or diagnostics". The
  build PR updates that boundary when the feature ships.

## Out of scope for this slice

- Session replay, DOM snapshots, screenshots, click/input tracking
  (outside the initial release).
- Full console capture: no `console.log`/`info`/`debug` wrapper
  (outside the initial release).
- Network body or header capture of any kind.
- Failed resource loads, performance metrics, Web Vitals.
- Capture before the widget config loads (inline early snippet).
- Source-map resolution of minified stacks.
- Agent-triggered "request fresh diagnostics" from a visitor.
- Diagnostics on email Conversations.
- Cross-Product Contact history of diagnostics (FR-INBOX-03).
- Configurable retention (the separate V2 retention-policies work).
- Alerting, grouping across Conversations, error dashboards: SupportSeal
  is not a Sentry replacement (PRD "Later and outside scope").

## Acceptance criteria

Stable IDs for the build thread. Each is testable.

- **DX-01 Off by default.** A new or existing Product has
  `diagnosticsEnabledAt = null`. Its widget config has no `diagnostics`
  flag, the loader never requests the collector bundle (verified via
  network log), and a message POST carrying `diagnostics` stores the
  message and returns `diagnostics: "rejected"`, reason `disabled`.
- **DX-02 Admin-only switch.** Only Admins can enable, disable or delete
  diagnostics for a Product in their Workspace; Agent and cross-Workspace
  attempts fail server-side with the standard not-found/forbidden
  responses. Enabling requires the confirm dialog; the setting records
  who and when.
- **DX-03 Capture allowlist.** With diagnostics on, a test page that
  throws an error, rejects a promise, calls `console.warn` and
  `console.error`, and makes a `fetch` and an XHR returning 500 plus one
  failing to connect produces exactly those events, with only the fields
  in the capture table.
- **DX-04 Hard bans.** The same test page sets cookies, `localStorage`,
  `sessionStorage`, a password field value, an `Authorization` header and
  secret-bearing request and response bodies, and calls `console.log` with
  a secret. None of those values appear anywhere in the stored snapshot or
  in the request payload (asserted by searching the raw payload for each
  canary string).
- **DX-05 Static ban gate.** The collector source-scan test exists in the
  unit suite and fails when a banned identifier is added.
- **DX-06 Redaction parity.** The client and server redaction
  implementations produce identical output for the shared fixture corpus;
  every rule has passing positive and negative fixtures.
- **DX-07 Server authority.** A hand-crafted payload with unredacted
  secrets, extra fields, oversized strings or > 32 KB is re-redacted,
  trimmed to fit, or rejected (`too_large` only when a single event cannot
  fit) server-side; the message is still stored.
- **DX-08 No send without a message.** Loading and using the page with
  errors, without sending a message, produces no diagnostics network
  request and no Conversation.
- **DX-09 Never blocks messages.** With the collector unresponsive or
  broken, a visitor message still sends, within the normal time plus at
  most 250 ms.
- **DX-10 Host page unaffected.** With wrappers installed, the host's
  `fetch`/XHR responses, return values, thrown errors and `console`
  output are unchanged (compared against the same page without the
  collector), and a collector exception does not surface to the page.
- **DX-11 Bounds.** Buffer, dedupe, window, snapshot size, per-message and
  per-Conversation limits behave as specified, and dropped counts are
  recorded.
- **DX-12 Attachment and isolation.** A snapshot belongs to exactly one
  customer Message; it appears in the agent view only; visitor endpoints,
  outbound email and the widget thread never include it; a snapshot ID
  from Workspace B is not readable from Workspace A (two-Workspace test,
  FRD acceptance path).
- **DX-13 Retention and deletion.** Snapshots past `expiresAt` are not
  returned; ingest purges expired rows for the Product; deleting a
  Message, Conversation, Product or Workspace removes its snapshots; the
  Admin delete action removes all of a Product's snapshots.
- **DX-14 Disable takes effect.** After an Admin disables diagnostics, the
  next message from an already-open widget is stored without a snapshot
  (`disabled`), and the next config load stops the collector.
- **DX-15 Developer pause.** `SupportSealWidget.diagnostics(false)` clears
  the buffer and stops collection until `diagnostics(true)`; it cannot
  enable a disabled Product.
- **DX-16 Agent display.** Chip, context section, `Sheet`, empty and
  expired states and Copy as text render as specified, text-only; a
  snapshot containing `<img src=x onerror=…>` renders as literal text.
- **DX-17 Budgets.** Loader stays ≤ 5 KB gzip; the collector is ≤ 4 KB
  gzip; both sizes are reported in the PR.
- **DX-18 Self-hosted parity.** The E2E diagnostics flow passes in
  self-hosted mode with no outbound request to any host other than the
  installation.

## Suggested test plan

- **Unit (Vitest)**: redaction rules with the fixture corpus; parity
  between client and server redaction; snapshot schema validation and
  bounds; dedupe and window logic; User-Agent parsing to family plus major
  version; collector source-scan ban gate; `expiresAt` filtering.
- **Integration (PGlite)**: message POST with valid, invalid, oversized and
  disabled-Product diagnostics (message always stored; correct rejection
  codes); cascade deletion from Message, Conversation, Product and
  Workspace; opportunistic purge; per-Conversation cap; cross-Workspace
  read attempts on snapshot and Conversation IDs; Admin-only
  enable/disable/delete.
- **E2E (Playwright, hosted and self-hosted)**: a fixture host page with
  canary secrets in every banned location, triggering each capture kind.
  Assert the captured request payload (via route interception) contains
  the expected events and none of the canaries. Then check the agent view:
  chip, section, `Sheet`, Copy as text. Also cover off-by-default (no
  collector request), disable mid-session, and "no message, no request".
- **Browser check (manual, screenshots in the PR)**: enable dialog, widget
  notice line, agent view in light and dark themes, with realistic data.
- **Host-compatibility smoke**: the collector on a React SPA, a
  multi-page site and a page that already wraps `fetch` (e.g. another
  error tool), confirming no double-wrapping breakage.

## Decisions and defaults

The maintainer's answers will be recorded here as (maintainer); *defaults* are
maintainer-overridable. Summary in `docs/open-questions.md`, "Diagnostics".

- **Location**: *default:* Product settings → Developer tab.
- **Delivery**: *default:* buffered in memory, sent only with a visitor
  message; never alone.
- **Collector loading**: *default:* separate bundle, loaded only when the
  Product is enabled; ≤ 4 KB gzip.
- **Warnings**: *default:* narrow `console.warn`/`console.error` wrapper;
  primitives as text, an `Error` as `name: message`, anything else as
  `[object]` ([Q3](#open-questions)).
- **Browser/OS**: *default:* parsed server-side from `User-Agent`; raw
  string not stored.
- **Bounds**: *default:* 50 events, 30-minute window, 32 KB per snapshot,
  100 snapshots per Conversation.
- **Retention**: *default:* 30 days from capture, fixed in this slice,
  hidden once expired ([Q2](#open-questions)).
- **Purge**: *default:* every read hides expired rows; each insert deletes
  up to 100 expired snapshots for that Product. Quiet Products keep those
  hidden rows until a scheduled purge exists ([Q4](#open-questions)).
- **Visibility**: *default:* Agents and Admins who can see the
  Conversation.
- **Widget notice**: *default:* one-line notice while enabled; wording
  from legal review ([Q1](#open-questions)).

## Open questions

Only decisions that need the maintainer; everything else above is a default.

- **Q1 — Notice or consent (legal).** Is a customer-controlled switch plus
  a widget notice enough, or must SupportSeal support a "wait for consent"
  mode (collect nothing until the site calls `diagnostics(true)`) and/or a
  visitor-facing opt-out in the panel, at least for EU/UK visitors (the
  GDPR/UK GDPR review is V2 work)? The design supports
  either; the default is the notice line plus the developer pause hook.
- **Q2 — Retention period (product/legal).** Is 30 days right for the
  hosted tier? Shorter reduces exposure; longer helps slow Conversations.
- **Q3 — Warning capture.** The PRD forbids arbitrary `console.log`
  capture but lists "warnings". Browser warnings are only observable by
  wrapping `console.warn`/`console.error`. Accept the narrow wrapper
  (default), or capture errors, rejections and network failures only and
  drop "warnings" from this slice?
- **Q4 — Scheduled purge (infrastructure).** Opportunistic purge on ingest
  leaves hidden expired rows for quiet Products. Adding a scheduled purge
  job is new infrastructure (no job runner exists today). Accept
  hidden-until-purged for this slice, or add a scheduled purge (and
  where: app-internal timer, Coolify scheduled task, or a self-hosted
  compose job)?
