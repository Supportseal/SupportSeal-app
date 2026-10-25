# Agent avatars, presence and typing — V2 design

Status: design for a later build; no implementation in this change. Based on
`origin/main` at `7f732e9`. This is the deferred presence half of
[PRD Later](../PRD.md#later-and-outside-scope), following diagnostics.
Product branding ([design/branding.md](branding.md) on main) explicitly leaves this work
separate. That merged design is a reference, not a dependency.

Choices labelled **Default** are working choices the maintainer can override, not
approvals. Policy questions are in [Open questions](#open-questions) and
indexed in [open-questions.md](../open-questions.md#presence-v2-design-2026-10-01).
FR-* references below constrain the extension; they do not make it V1 scope.

## Purpose and boundary

Help a small team recognise colleagues and notice when someone else is
answering the same customer. Let a visitor see that support is composing a
chat reply without promising an immediate response or revealing staff identity.
The same features run on the installation in both hosting modes (FR-HOST-01).

In scope: optional team-only agent photos, current dashboard activity,
Conversation viewing and composing hints, and two-way chat typing indicators.
No assignment, priority, routing, locks, draft sharing, workload management,
read receipts, response-time promises, staff activity history or analytics.
Assignment/priority (#39) may consume these hints later but owns its policies.
Custom sending domains (#38), accessibility hardening (#40) and analytics
(#41) remain separate; accessible behaviour is still required here.

Product logo/avatar, launcher position/icon and greeting belong to branding;
none is redesigned. No new public staff directory or visitor avatar collection.
Knowledge bases, AI agents, enterprise SSO/CRM, social/phone channels and a
mail server remain outside scope. No Redis, hosted presence vendor, new
background job or WebSocket service is assumed.

## Existing contracts and V2 additions

| Source | Retained contract / addition |
| --- | --- |
| FR-ACC-01, FR-SEC-01 | Admins and Agents operate their Workspace inbox. Every profile, signal and subscription is authorised; role and membership are checked server-side. |
| FR-PROD-02; [support-inbox.md](support-inbox.md) | Product marks and names remain in rows and headers. Agent avatars never replace them or imply ownership. |
| FR-INBOX-02/03; [conversation-view.md](conversation-view.md) | Notes stay private. Presence belongs to the selected Conversation, never a Contact's combined history across Products. |
| FR-CHAT-01/02/03; [chat-widget.md](chat-widget.md) | Origin and scoped visitor-session checks still apply. Messages remain durable and resumable; presence is disposable and never evidence of delivery/read. |
| FR-CHAT-04; D1/D1a in [open-questions.md](../open-questions.md) | Live/Away stays one Admin-controlled Workspace setting. Agent activity never changes it or changes required email capture. |
| FR-EMAIL-02; D4/D5 | Visitor-facing identity remains “{Product} Support”. Email sender identity and reply-channel selection are unchanged. |
| FR-SEC-02, FR-HOST-01, FR-USE-01 | No orphaned profile assets; no external identity service; signals create no Conversations, Messages, usage charges or analytics records. |

The neighbouring V1 designs retain their historical scope. The later build
reconciles affected implementation notes and shipped-feature claims.

## Agent avatars

**Default:** one optional photo per Workspace membership, visible only to
current members of that Workspace. A person in two Workspaces configures each
independently. Both roles may change their own photo through the account-menu
profile panel; Admins may remove another member's photo from Team settings,
but cannot upload a photo on their behalf. No new display-name policy: use
the existing team display name. Public names/photos require PQ1 to be revisited.

- Show a 28 px avatar beside the existing author label at the start of a
  dashboard message group and beside note authors; use 24 px in viewing
  hints and the existing size in Team/account surfaces. Historical messages
  show the current photo, not a snapshot. Never put a current-activity dot
  on historical messages: it could look like status at the time of sending.
- Missing, removed, loading or failed photos use up to two display-name
  initials, with a neutral token background and readable text. Missing names
  use a generic person icon and “Team member”; removed authors use
  “Former team member”. Do not derive initials from an email address.
- Keep the text label; adjacent images are decorative (`alt=""`). Reserve
  dimensions, show the fallback immediately and do not loop failed requests.
  Widget and email gain neither names nor photos under the default.
- Profile panel: labelled file input, preview, Replace, Remove, Save and
  Cancel. Selection/removal changes only the local draft. Cancel publishes
  nothing; Save reports validation/conflict/storage errors without losing
  the draft or replacing the saved photo on failure. Preview uses a local
  object URL, revoked on replacement or close. Explain team-only visibility.

**Default upload contract:** static PNG/JPEG/WebP, maximum 2 MiB input,
2,048 px per dimension and 4,194,304 decoded pixels. Reject SVG, GIF,
APNG/animated WebP, mismatched MIME/signature and malformed images. Decode,
orient, strip metadata, centre-crop to a square (shown in preview), and
re-encode as static WebP up to 128 × 128 px without upscaling, at most
32 KiB. Store only this derivative. No crop editor, remote URL import,
Gravatar, external identity-provider image URL or automatic use of `User.image`.

Authenticate before processing; bound multipart bodies to 3 MiB, decoder
memory/time and dimensions before allocation where possible. **Default:**
10 photo-changing attempts per member per 10 minutes, 30 per Workspace;
rejected uploads count. The build must choose a maintained decoder (PQ4),
not implement image parsing. Branding may share sanitisation/storage helpers
if it lands first, but public Product-logo access rules must never be reused
for private photos (FR-SEC-01/02, FR-FILE-01's private-file boundary).

## What presence means

**Default:** automatic, team-only dashboard activity. No personal
Available/Away/Busy selector, staffing rota or per-Product availability.
“Active in dashboard” means a visible dashboard tab had keyboard/pointer
activity within five minutes and has a fresh lease. It does not mean the
person will answer, has read a message or is available for every Product.
Observe activity timing only in the dashboard; never record keys or targets.

| State | Evidence and team-facing presentation |
| --- | --- |
| Active in dashboard | Fresh lease and activity within five minutes; dot plus explicit text. |
| Idle | Fresh lease from a visible tab, but five minutes without activity; neutral dot and “Idle”. |
| Not connected | Successful fresh server snapshot finds no unexpired visible-tab lease; “Not connected”, not “Offline since …”. |
| Unknown | Initial load, stale snapshot, transport/DB error; “Status unavailable”. Never reinterpret failure as idle or disconnected. |

**Default timing:** visible dashboard tabs heartbeat every 20 seconds; server
leases expire 60 seconds after receipt. Hiding a tab clears its viewing/typing
state and releases its lease best-effort. A visible idle tab continues a
heartbeat so Idle differs from Not connected. With several tabs/devices,
aggregate each member once: Active if any lease is active, otherwise Idle if
any survives. Closing one tab cannot clear another's lease. On logout or
membership revocation, invalidate the corresponding leases immediately in
storage; receivers lose the indication on their next authorised snapshot.
A hidden/suspended/crashed browser can remain indicated until its lease expires.

Show member status in Team and the current member's account menu. In a
Conversation header, show up to three other members viewing that Conversation,
then an accessible “+n” disclosure listing the rest with names and status.
Viewing requires the Conversation to be open in a visible tab, not merely
selected in saved navigation state; it is not a read receipt. A narrow viewport
uses a “2 teammates viewing” button instead of squeezing the Product label.
No presence badges on every inbox row, new filters, sorting or tab counts.

Workspace Live/Away remains separate and authoritative even when all agents
are disconnected or agents are typing while Away. Retain existing widget
availability wording; do not calculate an online-agent count, show a team
avatar stack or infer a response time. PQ2 records the choice explicitly.
Visitor connection evidence used by D5 remains separate: an absence of typing
or a closed panel does not change the chat/email routing rule.

## Typing and composing hints

**Default:** team composing hints work for Reply and Note; visitor-facing
typing is enabled for live chat under the rules below (PQ3). This is advisory
collision awareness, never a send lock, assignment or a guarantee against
duplicate replies. Two agents can still send; their real messages follow
normal ordering and deduplication (FR-INBOX-02, FR-CHAT-03).

| Recipient | What appears, only for the current Conversation |
| --- | --- |
| Other team members | “Sam is replying…” or “Sam is writing a note…”. Multiple authors: first two names then “and n others”; disclosure gives names and modes. No draft text. |
| Visitor | “Support is typing…” below the thread when at least one agent is actively composing a Reply with chat selected. Never expose names, IDs, counts, note activity, viewing state or email-draft activity. |
| Team viewing a chat | “Visitor is typing…” above the composer for that Conversation's authorised visitor session(s); aggregate tabs, do not infer identity from linked Contacts. |

**Default lifecycle:** start on a user edit in a focused, visible, nonempty
composer (including paste, saved-reply insertion and IME composition), not on
focus alone or restoring a draft. Refresh at most once every two seconds
while editing. After five seconds with no edit, emit stop. Server typing
leases last eight seconds from receipt; receivers also expire them locally.
Blur, empty draft, panel close, hidden page, navigation, Reply/Note or channel
change and send initiation stop the old signal immediately best-effort.
A failed send retains text but does not restart typing until another edit.
Attachment upload alone never indicates typing. Pending and Closed threads
may have hints; hints themselves never reopen a Conversation.

On Reply/Note or chat/email changes, clear the previous audience first;
a fresh edit starts the new mode. Server projection permits only explicit
chat Reply mode to reach a visitor. Notes may still be composed for archived
Products inside the team; archived Products have no public typing activity
and disallow new visitor signals, matching FR-PROD-01 and D2a.

Before a first message there is no Conversation: send no typing, create no
Conversation just for presence and share no away-form typing. Once a scoped
Conversation exists, visitor typing may reach its team even in Away mode;
agent chat typing can reach that widget if chat is explicitly selected.
The away email requirement still applies before sending (FR-CHAT-04).
Do not observe typing elsewhere on the embedding page (FR-CTX-02).

Hints occupy a reserved single-line area outside the message log, wrap or
expand accessibly on small screens, and never move scroll position or focus.
They create no unread badges, sounds, message previews, emails, timestamps in
history or “needs reply” state. Use text plus optional dots, not colour alone.
A separate polite live region announces a meaningful start/author change at
most once per ten seconds, never heartbeat refreshes. Dots become static under
reduced motion; disappearing hints need no announcement. New controls are
keyboard reachable, have visible focus and 44 px touch targets (FR-CHAT-05).

## Transport, authority and bounded state

[ADR-0003](../adr/0003-realtime-delivery.md) supplies the transport direction:
HTTP writes, SSE delivery, database coordination and polling fallback.
At this base, `src/lib/events.ts` wakes one process; widget polls every two
seconds and inbox polls every ten. SSE heartbeat comments prove transport
liveness, not human activity. A ten-second inbox poll can miss an eight-second
typing lease entirely; do not simply add typing to the existing event enum.

**Default:** keep short-lived leases in the existing database and add a
separate presence snapshot/event lane. Poll this lane every two seconds for
visible subscribers, with same-process wake-ups as an optimisation. The
selected Conversation is explicitly subscribed with ownership checks; the
team-status snapshot contains no unrelated Conversation IDs. Share a bounded
poll per process/Workspace and selected Conversation where practical; do not
accelerate all durable inbox queries. No Redis or durable typing event log.
Measure this cost with multiple processes before shipping.

Illustrative additive records/API, not committed schema or endpoint names:

- `MemberAvatar`: membership FK, generated storage key, revision, validated
  MIME/dimensions/size; one current derivative per membership.
- `PresenceLease`: server-bound principal/session, Workspace, per-tab client
  instance, server expiry, active/idle and optional viewed Conversation.
- `TypingLease`: that instance plus Conversation, mode (`chat_reply`,
  `email_reply`, `note`, `visitor`), sequence, expiry and active flag.
- Authenticated heartbeat/typing HTTP mutations derive membership and actor
  from the session. Visitor mutations derive Product and Conversation from
  the scoped visitor session, rechecking key, allowed origin and archive.
  A public key, supplied actor ID or guessed Conversation ID is insufficient.
- Snapshot reads and SSE writes project separate team and visitor payloads.
  Widget output contains only an aggregate `supportTyping` boolean, server
  time and expiry; no membership/photo/private mode fields. Team output is
  scoped to current membership and the authorised selected Conversation.
  Use the existing session/CSRF protections and no-store responses.

**Default ordering:** register a fresh, session-bound client instance on tab
load; never accept another principal's instance. Mutations carry increasing
per-instance sequence numbers and apply atomically only when newer. A stop
retains a tombstone/high-water mark for that live instance so delayed refreshes
cannot revive it. Retire instances after 90 seconds without heartbeat and
reject later writes. On reconnect or hidden-to-visible resumption (including
return from browser suspension), register a fresh instance before sending any
heartbeat or typing mutation, even if the transport stayed connected. Replace
any surviving instance for that same session-bound tab atomically so repeated
visibility changes do not consume extra instance slots; other tabs are unaffected.
Reset the new instance's sequence and local signal state, discard queued writes
and late responses for the old instance, and fetch a fresh snapshot. Restore
viewing only for the currently visible Conversation; typing requires a fresh
edit, never a restored draft. A retired-instance response while visible uses
the same recovery path without requiring a reload; ordinary auth failures do
not trigger re-registration retries. Bound live instances to ten per principal
per Workspace; reject excess registrations visibly rather than evicting
another active tab.
This also bounds the number of lease/tombstone records.

Server clock determines expiry. Snapshots carry server time and remaining
lease lifetimes; clients schedule expiry with elapsed time rather than trust
their wall clocks. Each subscription serialises snapshots, includes a
monotonic revision within its connection generation, and ignores older
responses/generations. A stop/message send clears the sending instance's
indicator, not another tab's independent draft.

On initial subscription or reconnect, take a fresh snapshot; never replay
presence via durable message cursors or queue unsent heartbeats. On transport
failure, clear typing immediately and mark team status Unknown. If no fresh
snapshot arrives for ten seconds, do the same even if SSE comments continue.
Fallback polling uses the same authorised snapshot and freshness rules.
Presence errors are observable via bounded reason-code logs and a quiet
“Live activity unavailable” team hint; message sends/retries remain independent.
No repeated toasts or retry loop without backoff. Avatar failure shows fallback.

**Default bounds:** mutation bodies at most 1 KiB, enum/ID/boolean fields
only, no draft text, key values or URLs. Per instance: 40 typing mutations
and four heartbeats per minute, allowing normal starts/stops; per principal:
400 typing mutations per minute across instances. Return 429 with retry
information; a rejected stop safely expires. Apply existing IP/registration
abuse limits too. Opportunistically delete up to 100 expired records per
Workspace on activity reads/writes, and reuse records for live instances;
always filter expiry before returning results. Quiet installations can retain
expired rows until access resumes: PQ5 is the explicit retention boundary.

Revalidate sessions, membership, Conversation ownership and Product state on
every write and snapshot, including existing streams. Revocation/deletion
clears applicable state and terminates or empties subscriptions; within the
two-second healthy poll bound no further private snapshots go to revoked
callers. Do not trust a permission check made only at stream connection.
Snapshots also exclude revoked/expired author sessions and removed memberships,
so an invalidated author cannot linger until the ordinary lease timeout.
A linked Contact never gives access to another Product's presence (FR-INBOX-03).

## Avatar storage, deletion and rollout

**Default:** use the existing local attachment-storage abstraction with distinct
membership metadata and authenticated reads. Serve current photo bytes only
to the same Workspace, with `Cache-Control: private, no-store`, correct MIME
and `nosniff`; never expose a public logo URL, raw storage path or arbitrary
attachment reference. Removed/replaced IDs return 404. Already rendered or
saved copies cannot be recalled. Self-hosted files live in the installation's
persistent volume and are included in backup/restore (FR-HOST-01).

Stage a sanitised replacement, commit the reference with an expected revision,
then remove superseded bytes. Conflicting saves retain the winning image and
return a visible conflict. Compensate failed transactions and surface failed
file cleanup with retry ownership; crashes between file/DB steps require the
recovery procedure in PQ4. Membership/account/Workspace deletion removes
photos and leases; Product/Conversation deletion removes their scoped leases.
Removing a membership must not leave its photo visible on historical messages.
No presence history, last-seen field, exports or analytics events are added;
request logs must omit session tokens, payloads and staff activity timelines.

**Default migration:** nullable photos, no initial leases, no copying of global
profile image URLs and no historical backfill. Existing author attribution,
Product branding, status, reply routing and billing remain intact. Old clients
ignore optional presence fields; new clients talking to old endpoints hide
unsupported hints. Preview fixtures are local-only and create no live leases.
A rollback can disable the presence lane without affecting message delivery;
photo bytes still require documented cleanup and backup handling.

## Acceptance criteria and later verification

Stable IDs for the build; test timings with a controlled clock.

| ID | Observable result and requirement |
| --- | --- |
| PRS-01 | Both roles save/remove their own Workspace photo; Admin can remove a teammate's. Cross-Workspace reads/writes and Agent edits to others fail; no global image URL is fetched (FR-ACC-01, FR-SEC-01). |
| PRS-02 | Valid uploads normalise within limits; limit + 1, spoofed, animated, oversized-decoded and malformed inputs fail. Save/Cancel/conflict/storage failure preserve the correct saved image; replacement and deletion remove bytes or expose a tracked cleanup failure (FR-SEC-02). |
| PRS-03 | Current photos/fallbacks render beside dashboard authors in light/dark themes; former members lose photos. Product marks stay intact and widget/email payloads contain no staff identity (FR-PROD-02, D4). |
| PRS-04 | Five-minute idle and 60-second expiry transitions match the table. Multiple tabs/devices aggregate once; one tab closing does not clear others. Failed/stale reads give Unknown, never an inferred offline state. |
| PRS-05 | Viewing appears only for the visible selected Conversation; no cross-Product Contact history, row reordering, unread changes, assignment or read receipt results (FR-INBOX-01/02/03). |
| PRS-06 | First edit, refresh, pause, blur, hide, navigation, send/failure, IME, mode/channel change and eight-second expiry follow the lifecycle. Draft restore, attachment upload and first-contact/away forms send no typing. |
| PRS-07 | Team sees named Reply/Note hints; visitor sees only aggregate chat Reply typing. Switching to Note/email clears the public hint; malicious mode/actor/Conversation payloads cannot reveal private activity (FR-INBOX-02, FR-SEC-01). |
| PRS-08 | Delayed refresh after stop, reversed HTTP responses, tab races and old stream generations cannot resurrect stale indicators. Reconnect and resumption after more than 90 seconds hidden register a fresh instance before writes, recover viewing without a reload and require a new edit for typing. Rapid hide/show cycles do not exhaust instance slots or clear other tabs; durable messages still resume without duplicates (FR-CHAT-03). |
| PRS-09 | Two app processes behind the proxy exchange typing within the two-second poll interval plus request latency; eight-second hints are not lost to the existing ten-second inbox tick. Measure query/request load at the configured instance limits. |
| PRS-10 | Workspace Live/Away and required reply email remain unchanged with zero/many active agents; typing does not alter D5 routing, reopen a thread or count usage (FR-CHAT-04, FR-EMAIL-02, FR-USE-01). |
| PRS-11 | Two Workspaces and two Products exercise guessed IDs, foreign visitor sessions, disallowed origins, archive, logout/revocation and deletion on already-open streams. No forbidden snapshot or photo is served (FR-CHAT-01/02, FR-SEC-01/02). |
| PRS-12 | Network/DB outage, server restart and rate limits clear stale hints on schedule, preserve drafts and allow independent message handling. Expired rows are hidden and bounded cleanup runs as specified. |
| PRS-13 | Keyboard, touch, narrow screens, long names, reduced motion and screen-reader announcements work without focus/scroll changes or per-heartbeat announcements (FR-CHAT-05). |
| PRS-14 | Hosted and self-hosted browser flows have feature parity with no external photo/presence service calls; fresh installs and upgrades retain existing chat/email behaviour (FR-HOST-01). |

Build verification: repository lint, typecheck, unit/integration tests and
build; hosted/self-hosted critical-path browser tests and independent review
of authorisation and uploads. Unit tests cover projection, aggregation,
sequence/expiry and bounds. PGlite integration tests cover tenancy, role checks,
revocation, cleanup and concurrent writes; a two-process test validates fan-out.
Browser checks use two agents and a visitor with realistic names/photos on
mobile/desktop and dashboard light/dark themes. Recheck loader/panel gzip
sizes against the [chat-widget.md](chat-widget.md) budgets (D10: 5/50 KB);
no dashboard library or image decoder enters the widget.
This document specifies those future checks; it does not claim they ran.

## Open questions

No answer is needed to finish this document. Defaults apply until overridden;
unresolved dependency/recovery choices need a concrete proposal before build.

| ID | Maintainer-facing policy / alternatives | Working choice or unresolved boundary |
| --- | --- | --- |
| PQ1 | Keep staff names/photos internal, or offer explicit visitor-facing identity per Product? Public identity would need staff consent, aliases, visibility and removal rules. | **Default:** internal only; preserve D4 and generic public typing. No public-identity controls in this slice. |
| PQ2 | Keep automatic activity informational, or add personal availability/automatic Workspace switching? Automation could promise coverage that a small team cannot provide. | **Default:** automatic team-only Active/Idle/Not connected/Unknown; Workspace Live/Away stays manual and separate. |
| PQ3 | Enable visitor typing by default, require Product opt-in, or add a visitor opt-out? Activity timing still reveals behaviour even without draft content. | **Default:** enabled for established chat Conversations, with generic agent identity and no away-form/pre-message collection. Review disclosure before shipping; any required consent/opt-out must be designed before enabling it. |
| PQ4 | Which maintained image decoder and crash/file-cleanup procedure should implementation use? Share branding helpers if available, or propose an independent minimal implementation. | **Unresolved:** choose dependencies and recovery ownership before implementing uploads. No new service/job is approved; do not weaken sanitisation or hide cleanup errors. |
| PQ5 | Is read-time expiry plus bounded opportunistic deletion acceptable, or must inactive installations physically purge on a deadline? | **Default:** ephemeral semantics with opportunistic deletion; expired rows may remain on disk/backups until cleanup/backup expiry. No activity history UI or scheduled worker. A strict physical-retention deadline needs an approved operating procedure. |
