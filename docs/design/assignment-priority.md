# Conversation assignment and priority — V2 design

Status: proposed build contract, 2026-10-01. Based on current main at `0048aa8`; this is a
documentation-only proposal, not implemented behaviour or a V1 scope change.
Working defaults below apply to the later build unless the maintainer overrides
them; they are not decisions already approved by the maintainer.

## Purpose and boundary

Give Admins and Agents a lightweight way to answer “who owns this?” and
“what should we handle first?” within the existing unified searchable inbox.
V1 already has Product scope, Open/Pending/Closed, notes, tags and saved
replies. V2 adds one optional assignee and one fixed priority per Conversation,
plus filters and a priority sort. Assignment expresses responsibility, not
exclusive access or a lock on replying.

The [PRD](../PRD.md) Later order remains diagnostics, richer branding and
presence, assignment and priority, verified custom sending domains,
accessibility hardening, then analytics. Diagnostics implementation and the
branding/sender-domain designs are separate work; this proposal does not
rework or depend on their unfinished changes. The separate `branding.md`
work owns Product logos and custom greetings and defers agent avatars,
presence and typing indicators. That file is not on this main baseline;
none of those features is specified here.

Non-goals: SLA timers, due dates, escalation policies, round-robin or
workload-based auto-assignment, teams/queues, multiple assignees, routing
rules, complex workflows/CRM, saved views, per-agent unread tracking,
collision detection, a notification centre, analytics, or customer-visible
priority/ownership. No new infrastructure, dependencies or scheduled jobs
are proposed. Bulk selection/actions are deferred from this first slice.
Basic keyboard and text-label support is part of these controls, without
expanding into the later accessibility-hardening project.

## Roles and ownership

| Operation | Admin | Agent |
| --- | --- | --- |
| See all Workspace Conversations and their ownership/priority | Yes | Yes |
| Assign to self or another current Workspace member | Yes | Yes |
| Unassign or reassign someone else's Conversation | Yes | Yes |
| Change priority, including on someone else's Conversation | Yes | Yes |
| Reply, note, tag or change status regardless of assignee | Existing rights | Existing rights |
| Invite/manage members or delete Conversations | Existing Admin rights | No additional rights |

Eligible assignees are accepted, current `Membership` records with role
`ADMIN` or `AGENT` in the same Workspace. Pending invitations and removed
members are excluded. Admins may own Conversations too. Membership is not
restricted per Product; assigning a Conversation never grants access to a
Workspace or changes customer identity. “Mine” is a filter, never an access
boundary. All members can see assignment/priority history.

Self-assign is explicit: **Assign to me**. On an already assigned Conversation
it is an ordinary reassignment, subject to the same conflict check as other
changes. **Unassigned** removes ownership. Selecting the current value is a
no-op. No confirmation dialog is needed for these reversible actions.

If a member leaves or their account is deleted, their Conversations become
Unassigned, keep priority/status, and record a system change. Membership
removal and reassignment must serialize so a concurrent assignment cannot
leave a removed member as owner. Rejoining does not restore old assignments.
This is a requirement for removal/deletion paths, not a proposal to build a
new membership-management UI. Switching Admin ↔ Agent retains assignments.

## Priority and lifecycle

| Stored value | Display label | Meaning | Priority sort rank |
| --- | --- | --- | --- |
| `URGENT` | Urgent | Team judges it needs immediate attention | 3 |
| `HIGH` | High | Handle ahead of routine work | 2 |
| `NORMAL` | Normal | Routine support; default | 1 |
| `LOW` | Low | Can wait behind other work | 0 |

These are fixed labels, not configurable Workspace or Product taxonomies.
Priority is always stored, defaults to Normal, and requires no agent input
before replying. There is no separate “unset” state. Urgent implies no
response-time promise, timer, email alert or escalation. Use text labels and
a small icon with theme tokens; never communicate priority by colour alone
or reuse the outbound-delivery failure indicator.

- All new chat, away-form and email Conversations start Unassigned/Normal,
  as do pre-existing Conversations after migration. No ownership is inferred
  from past replies. Test Conversations follow the same defaults.
- Replying, inserting a saved reply or adding a note never claims a
  Conversation. Priority never changes automatically from message content,
  customer context, Product, channel or status.
- Open → Pending → Closed and manual reopen retain both fields. A customer
  or agent reply reopening the same Conversation also retains both, unless
  the assignee has ceased to be a member. Explicit send-and-status actions
  keep their existing final-status semantics.
- Closing does not lower priority or release the assignee. Assignment or
  priority changes on Closed do not reopen it, change `closedAt`, create a
  message, or alter usage. High-priority Closed items stay out of Open.
- Archived Product Conversations still allow internal triage, matching the
  existing allowance for notes/tags/status. Customer replies remain blocked
  until unarchive; assignment never bypasses that restriction.
- Existing message activity and “needs reply” semantics remain. A metadata
  edit changes `updatedAt`, but never `lastMessageAt`, first-reply time,
  message preview, delivery state or billing count.

## Surfaces

### Inbox list, filters and sort

Keep the `support-inbox.md` list/pane layout; do not introduce a table or
configurable columns. The requested assignee/priority “columns” are compact,
labelled metadata on each list row. Preserve Product identity, contact,
preview, channel and delivery-failure signal. Add a triage line with
**Assignee: Unassigned** or the member's display name and **Priority: Normal**
(or the selected level). Allow row height to grow beyond the V1 three lines;
truncate long names with the full text available on focus. Reduce visible
tags before hiding triage metadata. Use text, not agent avatars/presence.
Rows remain a single navigation target; changes happen in the header.

Place compact Assignee, Priority and Sort controls below search/status.
On narrow screens use a **Filters** button with a labelled active-filter
count and a popover/sheet containing the same controls; keep the current
sort discoverable. Values are reflected in the URL and survive reload,
opening a Conversation, Back, and Product scope changes.

| Control | Values | Default |
| --- | --- | --- |
| Assignee | All assignees, Mine, Unassigned, a selected current member | All assignees |
| Priority | All priorities, Urgent, High, Normal, Low | All priorities |
| Sort | Latest activity, Priority first | Latest activity |

Proposed URL additions: `assignee=mine|unassigned|<membershipId>`,
`priority=urgent|high|normal|low`, `sort=activity|priority`; omit default
values. Each filter is single-select. “Mine” resolves to the signed-in
member, so the same shared link means each viewer's own Conversations.
Member names do not belong in URLs.

Combine Product, assignee and priority with AND. Without search, apply the
selected status (Open by default). With `q`, search across statuses as in
V1, retaining Product/assignee/priority and sort; show status on results.
Clearing search restores the selected status. Status-tab counts reflect
Product + assignee + priority, ignoring the selected status; tabs are hidden
while searching. Global sidebar counts keep their Workspace-wide meaning.
A search-result total, if shown, uses all active search/filter predicates.

Latest activity orders by `lastMessageAt DESC, id DESC`. Priority first
orders by explicit rank DESC, then `lastMessageAt DESC, id DESC` within each
level. It does not blend statuses or pin Urgent across filters. In particular,
assignment alone does not move a row in Latest activity; a priority change
can move it in Priority first. Do not rely on alphabetical enum order.

Changing a filter/sort resets pagination. Empty filtered results say
“No conversations match these filters” with **Clear triage filters**, which
retains Product, status and search. Invalid filter/sort input gets a
recoverable “Filter unavailable” state and a clear/reset action; it must not
silently widen results. A removed or foreign member ID produces the same
unavailable response, with no name or indication of Workspace membership.

On committed changes, refetch affected rows and counts via existing
Workspace realtime delivery. A row leaving the filter disappears while an
open thread and its unsent draft remain available. Reordering must not move
rows under the pointer when scrolled away from the top: offer **List updated**
to apply the refreshed order, adapting V1's “n new” behaviour. Reconnect
refetches current state. Metadata updates are not new customer messages.

### Conversation header

Add a second compact header row beside/below the existing status controls:

```text
Contact · Product · Channel                    Status / Close
Assignee: Unassigned ▾    Assign to me          Priority: Normal ▾
```

The assignee picker has Unassigned, Assign to me and a searchable list of
current Workspace members, with the current selection marked. Show names
and role labels; use member email only inside the authenticated picker to
disambiguate duplicate names. Do not infer availability. The priority menu
lists Urgent, High, Normal, Low with the selected level marked.

On mobile, wrap these labelled controls below Product/status without
horizontal scrolling or hiding them in the context panel. Both controls
work by keyboard, expose selection and busy/error state, and restore focus
on close. The list row's accessible name includes assignee and priority.

Save immediately on selection, disable the affected controls while pending,
and display the committed value after success. Keep the previous value on
failure with an inline retryable error; do not show a success toast for a
failed save. A quiet success toast names the new assignee/priority. No Undo
in this slice: choose the previous value to reverse, creating another
history entry. Remote changes update the header without interrupting the
composer; stale local edits show a conflict and require a fresh choice.

### History and notification touchpoints

Record assignment and priority changes as team-only system activity in the
Conversation thread: “Sam assigned this conversation to Lee”, “Sam removed
the assignee”, “Sam changed priority from Normal to High”. Include timestamp
and previous/new values; reassignment names the previous owner too. History
is visually distinct from notes/messages and never becomes the inbox
preview, a customer message, or a customer-email event.

Default notification scope is the open dashboard: realtime updates to Mine,
filters/counts/header and a quiet toast to an active assignee session when
another member assigns it to them. A reassigned-away active member receives
the corresponding notice. Self-assignment only gets the normal save toast;
priority changes need no targeted alert. Toasts link to the Conversation,
are de-duplicated by change ID per session, and are not replayed on reconnect.
Durable history/current ownership supply the truth after reconnect.

No delivery guarantee for an inactive dashboard; no email, browser push,
badges for unseen assignments, notification preferences, or background job.
Assignment never sends a message to the customer. AP-Q2 below explicitly
leaves offline assignee notification for the maintainer to reconsider.

## Data model and API sketch

Main currently has `Conversation`, `Membership`, `Message`, inbox server
actions, `GET /api/inbox` and Workspace SSE. Extend those paths rather than
creating a parallel ticketing subsystem. Names here describe a contract;
the build may use existing server actions instead of adding HTTP mutations.

| Addition | Contract |
| --- | --- |
| `Conversation.assigneeMembershipId` | Nullable relation to a current member of this Conversation's Workspace |
| `Conversation.priority` | Required enum above, database default `NORMAL` |
| `Conversation.triageVersion` | Integer, initially 0; increment once per actual assignment/priority mutation |
| `ConversationTriageChange` | ID, Workspace/Conversation IDs, timestamp, actor member reference (nullable for system/deleted member), reason (`manual` or `member_removed`), before/after assignee references and priority, resulting version |

Use membership references rather than bare user IDs. Enforce same-Workspace
relationships in the transactional domain service and use composite foreign
keys/constraints where appropriate; a foreign key on membership ID alone
proves existence, not tenant ownership. Explicit membership/account removal
must clear ownership and create history atomically; a fallback database null
relation must not substitute for that lifecycle rule. Serialise removal and
assignment using transactional locking or equivalent conflict detection.

History is separate from `Message`; widget/email serializers and visitor SSE
must never expose it, member rosters or triage fields. Show current member
names when references exist and “Former member” after removal, without
persisting email/name snapshots. Deletion nulls historical actor/assignee
references while retaining non-identifying transitions. Conversation,
Product or Workspace deletion cascades its triage history under FR-SEC-02.
Keep history for the Conversation lifetime; no independent retention service
or full audit-log product. Paginate it and merge it with thread items by
stable timestamp/ID ordering without changing message counts/read cursors.

Proposed operations:

- Extend `GET /api/inbox` with the filter/sort contract above; list/detail
  responses include assignee summary, priority and triage version. Roster
  lookup returns only current members of the authenticated Workspace,
  bounded/paginated and searchable by name/email for the picker.
- An authenticated `updateConversationTriage` server action accepts
  `{ conversationId, expectedVersion, assigneeMembershipId?, priority? }`.
  Omitted fields stay unchanged; explicit `null` unassigns, and `null`
  priority is invalid. Reject unknown fields/values and an empty patch.
  If exposed as HTTP later, the equivalent is a PATCH with the same contract.
- Read current membership/role and scope the Conversation by authenticated
  Workspace, then validate target membership in that same Workspace. Update
  fields and increment version with compare-and-set, and insert history in
  one transaction. No-op values produce no version/history/event. Check
  version first: stale edits return a conflict even if now a no-op.
- A version conflict returns current authorized triage values and a
  “Changed by another team member; review and try again” error. Do not retry
  stale intent automatically. An ambiguous network failure refetches state
  before offering another attempt. Two simultaneous self-assigns cannot
  both succeed from one version.
- Emit a Workspace-only triage event after commit, containing Conversation
  ID, change ID and version for refetch/de-duplication. Failed transactions
  emit nothing. Use the existing SSE delivery/refetch pattern, not a new bus.

Assignee/priority updates do not overwrite status or message fields. API
reads, writes, member lookup, history, filters, counts and pagination all
prove Workspace ownership server-side (FR-SEC-01). Use existing session and
CSRF/origin protections for actions. A visitor/widget credential cannot call
these operations. Missing/foreign Conversation IDs share “Conversation not
found”; invalid/foreign assignees share “Assignee unavailable”. Never trust
Workspace IDs or Mine's user identity supplied by a client.

Pagination must use the full active sort tuple, including ID as tie-breaker,
and validate cursor/filter context without trusting a cursor's tenant.
An opaque cursor contains or binds the sort values and active query. Stable
data must yield no duplicates/omissions across pages. After realtime changes,
reset/refetch the paginated list rather than append against stale boundaries;
this slice does not promise a snapshot across concurrent edits. Plan indexes
for Workspace/status/assignee/activity and priority ordering, retaining
Product/search predicates; verify against representative multi-Product data.
Do not add indexes for every possible filter combination speculatively.

The later build adds an additive migration, backfills Unassigned/Normal and
version 0, and emits no artificial historical assignment events. Cover all
creation paths and hosted/self-hosted upgrades. This design commit changes
no schema, routes, permissions or runtime code.

## Relationship to existing documents

| Source | V2 addition and preserved rule |
| --- | --- |
| [support-inbox.md](support-inbox.md) | Adds the deferred assignment/Mine, priority and sort subset. Keeps list panes, Product identity, search across statuses, needs-reply and realtime stability. Bulk actions/saved views remain deferred. The explicit activity sort above clarifies that triage edits do not count as new message activity. |
| [conversation-view.md](conversation-view.md) | Adds header controls and private system history. Keeps status/reply controls, drafts, notes, channel rules, sender identity and Admin-only deletion. No presence, typing or collision UI. |
| [product-settings.md](product-settings.md) | No assignment/priority settings or Product-specific defaults. Keeps archive restrictions; internal triage follows the notes/tags/status exception in conversation-view.md and D2a, despite the broader “read-only” shorthand in settings. |
| [FRD](../FRD.md) FR-ACC-01, FR-INBOX-01/02/03 | Both roles operate the unified Workspace inbox. Ownership never removes other members' access; chat/email continuation remains one Conversation with the same triage values. |
| FR-USE-01; [open-questions.md](../open-questions.md) D3 | Preserve the decided reopen-same-Conversation rule and once-ever usage count. Current FR-INBOX-02 names the statuses but does not itself spell out the reopen rule; D3 and the V1 designs do. |
| FR-PROD-01/02, FR-EMAIL-02/03 | Preserve Product identity/archive behaviour, managed sender rules and distinct delivery-failure follow-up. |
| FR-SEC-01/02, FR-HOST-01 | Tenant/visitor isolation, deletion cleanup and identical core behaviour in hosted and self-hosted modes. |

The implementation should promote the accepted V2 behaviour into separately
identified FRD requirements and update the three surface docs in its own
change. This proposal does not rewrite their historical V1 boundaries.

## Defaults and open questions

These are explicit working defaults for implementation, not unanswered
blockers or inferred approvals. The maintainer can override them; an override must
update this contract and its acceptance criteria before the build. There
are no blocking product decisions for the scoped slice. The index in
[open-questions.md](../open-questions.md#assignment-and-priority-v2-design-2026-10-01)
points here as the owning document.

| ID | Question for the maintainer | Proposed default and trade-off |
| --- | --- | --- |
| AP-Q1 | Auto-assign on first agent reply? | **Default: no.** Explicit ownership avoids silently taking a Conversation while helping. Opt-in or first-reply automation would be a follow-up decision, not hidden in send logic. |
| AP-Q2 | Notify the assignee when their dashboard is inactive? | **Default: no.** Active-dashboard toasts, Mine and history only; this can miss an offline handoff. Email would need a separately specified delivery/preference policy before adding it. |
| AP-Q3 | Must someone explicitly choose priority? | **Default: no.** Persist Normal automatically; every Conversation has a priority without a triage gate. No “unset” level. |
| AP-Q4 | Does reopening retain assignee and priority? | **Default: yes**, while the member remains eligible. Preserves continuity; the team can explicitly unassign or lower priority. |
| AP-Q5 | May Agents reassign anyone's work and change priority? | **Default: yes**, equally with Admins. Matches shared inbox operation; private history and version conflicts provide accountability, not an Admin bottleneck. |
| AP-Q6 | Bulk assignment/priority in the first slice? | **Default: defer.** Header-only mutation keeps selection, partial failure and conflict handling small. No hidden bulk API is required. |
| AP-Q7 | Make Priority first the default inbox order? | **Default: no.** Retain Latest activity and offer an explicit URL-persisted sort; Urgent is not an implicit global override. |

## Acceptance criteria for the later build

The AP identifiers below are local V2 acceptance IDs, not existing FRD IDs.

| ID | Observable result / required proof |
| --- | --- |
| AP-01 | Upgrade populated data and create chat, away and email Conversations: all start Unassigned/Normal/version 0. Existing messages, status, timestamps and usage remain unchanged; no fabricated history. |
| AP-02 | As both Admin and Agent, assign to self, assign another Admin/Agent, reassign and unassign. Both roles see the same ownership and can still reply to anyone's Conversation. Pending invites are absent. |
| AP-03 | Select each priority, including while Pending/Closed. Status, ownership, preview, needs-reply, last message time and billing do not change. Urgent is labelled and distinct from failed delivery. |
| AP-04 | Product + Mine/Unassigned/member + priority filters compose correctly. Search spans statuses but honours the other filters. Clearing search restores status; tab counts match triage scope and sidebar counts remain global. Empty/invalid filters do not silently broaden results. |
| AP-05 | Latest activity and Priority first match the specified tuples, including equal timestamps, mixed priorities and multiple pages. Stable data has no missing/duplicate rows; a filter/sort change resets cursors. |
| AP-06 | Closing, manual reopening, customer/agent reply reopening, chat-to-email continuation and send-and-status retain triage values and count no extra usage. Reply/note never auto-assigns. Archived Product triage works while customer replies stay blocked. |
| AP-07 | Two sessions editing the same version produce one success and one visible conflict, with no lost ownership update or duplicate history. A failed transaction changes neither state nor history and sends no event. No-op writes create no activity. |
| AP-08 | Another session's change updates header/list/counts and adds private history. Filter departures keep the open draft intact. Priority reorder while scrolled offers List updated; reconnect refetches without replaying toasts. Active handoff notices reach the new/previous assignee as specified. |
| AP-09 | Remove/delete an assigned member, including racing a new assignment: no Conversation remains assigned to the removed member. History shows the system transition and former-member placeholders; rejoining does not reclaim work. |
| AP-10 | In a two-Workspace test, foreign Conversation/member IDs, cursors, filters, history and SSE cannot read, count or mutate another tenant's data. Visitor/widget credentials cannot see or edit triage metadata or member lists. Stale sessions lose access after membership removal. |
| AP-11 | Delete owning data: triage history is cleaned up and deleted account/member names/emails are not retained as snapshots. No history line enters the widget, outbound email, message preview, unread/read state or message counts. |
| AP-12 | In a browser at desktop and 320px mobile width, use filters, both header pickers and Back with realistic long/duplicate names. Keyboard operation, focus return, visible text labels, loading/failure/conflict states and draft preservation work without horizontal overflow. |
| AP-13 | Run the same triage workflows hosted and self-hosted, without Stripe or an external notification service. Existing inbox reply/note/tag/saved-reply/status flows still work. |

Build verification: run the repository's ordinary lint/typecheck/tests/build
chain, PGlite migration/domain/tenant integration tests, and browser tests
covering assignment, filtering, conflicts and cross-Workspace rejection.
Include visual inspection of the new controls and realistic populated rows.
Use targeted cases above; do not make deferred notifications, bulk actions,
branding, diagnostics or analytics prerequisites.
