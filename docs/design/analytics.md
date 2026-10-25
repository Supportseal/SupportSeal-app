# Product analytics — V2 design

Status: design direction for a later build, not shipped functionality.
Prepared against main `f45e21d` (merged diagnostics build). This document
covers the PRD's **“more analytics”** product slice, not launch-readiness
marketing analytics. It changes no V1 behaviour, pricing or public claim.
Items marked **Default** are working choices the maintainer can override; unanswered
policy decisions are collected under [Open questions](#open-questions) and
indexed in [open-questions.md](../open-questions.md).

## Goals and scope

Help a small support team answer: how much support arrives, which Products
need attention, how quickly humans respond, whether requests arrive while
support is Live or Away, and how the team shares reply activity.

- Provide Workspace and Product support metrics to Admins and useful,
  limited summaries to Agents, with identical core functionality in hosted
  and self-hosted installations. **Default:** available on every plan;
  hosted billing remains a separate Admin surface.
- Derive metrics from durable support operations inside the installation.
  No visitor tracking SDK, external analytics account or extra browser
  collector is required. Self-hosted operation stays independent of hosted
  APIs, Stripe and external telemetry (FR-HOST-01).
- Make denominators, missing history and time boundaries visible. These are
  operational signals, not service guarantees or staff performance scores.

Non-goals: marketing attribution, page views, funnels, session replay,
customer behaviour tracking, cross-Workspace benchmarks, revenue analytics,
CSAT, SLA/business-hours clocks, resolution-time targets, alerts, exports,
scheduled reports, AI analysis or AI support agents. No agent avatars,
presence, typing indicators, online-time tracking or inferred availability.
No new assignment/priority, branding, sending-domain or accessibility design.
Workspace Live/Away is the existing manual setting, not agent presence.

## Requirements and neighbouring designs

[PRD](../PRD.md) and [FRD](../FRD.md) remain canonical. The Later sequence is
diagnostics → richer branding and presence → assignment and priority →
verified custom sending domains → accessibility → analytics. Diagnostics is
merged. The separate open designs for branding (#37), sender domains (#38),
assignment/priority (#39) and accessibility (#40) retain their own scope and
decisions; this document neither replaces nor imports their unmerged work.
Branding owns Product logo, launcher corner and custom greeting. Deferred
avatars/presence/typing work remains outside this slice.

| Existing contract or design | Relationship to this slice |
| --- | --- |
| FR-ACC-01, FR-INBOX-01, FR-SEC-01; [app shell](app-shell.md), [Product switcher](product-switcher.md) | Reuse membership, role and Product scope. Add an Analytics destination; keep the inbox as the default landing page. |
| FR-INBOX-02/03; [support inbox](support-inbox.md), [Conversation view](conversation-view.md) | Status changes, notes and channel continuation retain their meaning. Reopening is not a new Conversation. Analytics drill-through uses existing authorised inbox views. |
| FR-CHAT-03/04; [chat widget](chat-widget.md) | Measure recorded replies and Workspace availability at intake, without promising delivery/read status or adding widget behaviour. |
| FR-PROD-01; [Product settings](product-settings.md) | Archived Products retain history. Analytics does not add Product configuration or change archive/delete rules. |
| FR-EMAIL-01/02/03 | Keep opening channel distinct from later transport. Failed delivery stays visible in the existing delivery workflow. |
| FR-HOST-01; [architecture](../architecture.md) | Local support reporting works in both modes. The architecture's “hosted-only … optional analytics” wording describes external/marketing integration; this V2 proposal adds app-owned reporting to the shared core. Make that distinction explicit in architecture/FRD when implementing. |
| FR-USE-01/02 | Usage remains authoritative for allowances, notifications and billing; analytics cannot feed or override it. |
| FR-SEC-02; [diagnostics](diagnostics.md) | Deletion propagates to derived data. Diagnostics payloads and their separate 30-day expiry are not analytics inputs. |
| Marketing site (`docs/design/marketing-site.md` in the private `supportseal-marketing` repository) | Umami remains hosted-marketing-only, environment-gated and off by default. No support/customer data is sent to it. |
| Separate assignment/priority design | Activity belongs to the human author, never an inferred assignee. Assignment, workload by owner and priority filters are deferred extensions. |
| Separate accessibility design | Reuse its adopted components and guidance when available; this surface still requires keyboard access, labelled controls and readable data tables. |

The build should add V2 analytics requirements with new stable FRD IDs,
linking to the acceptance IDs below, rather than rewriting the V1 hosting or
usage contracts. This design alone does not promote proposed features into
shipped marketing features (`docs/marketing/shipped-features.md` in the private `supportseal-marketing` repository).

## Metric contract

**Default reporting window:** last 30 UTC calendar dates including today;
7-day, 30-day and 90-day presets, and a custom range within that same rolling
90-date horizon. Show “UTC” beside dates. A selected date range is
`[start midnight, midnight after end date)`, capped at the displayed report
“as of” time for today. All cards in a response use that same cutoff. This
avoids a new Workspace timezone setting and aligns monthly reconciliation
with current usage. No business-hours subtraction or pausing while Away,
Pending or Closed. Future timestamps and negative intervals are excluded
with an explicit data-quality count, never clamped into valid samples.

Filters: all Products or one Product; archived Products included by default
and labelled. No silent test/spam/tag exclusions: existing test Conversations
count normally, just as they do for usage. Rejected intake that never creates
a Conversation contributes nothing. Deleted records follow the deletion
policy below. No Contact-level grouping or cross-Product identity joining.

### Definitions

| Metric | Definition and window membership |
| --- | --- |
| Conversations opened | Count distinct Conversations whose original `createdAt` falls in the window. One opening per Conversation ever. Status changes, replies and chat/email handoffs never add openings. |
| First response time (recorded) | For Conversations opened in the window, elapsed time from the first persisted customer Message to the first subsequent persisted human `AGENT` Message, through “as of”. One sample per Conversation. Show median and p90, answered sample size and not-yet-answered count. Conversations without a customer Message are “not measurable”, not zero. |
| Follow-up response time (recorded) | After a human reply, the next customer Message starts a waiting episode. Further customer Messages before the next human reply belong to that same episode; they do not reset its start. The next human reply ends it. Select episodes by customer start time in the window, even if the Conversation opened earlier. Show median/p90, completed and still-waiting episode counts. The initial episode belongs only to first response. |
| Live vs Away at opening | Split window openings by the Workspace setting read authoritatively when the Conversation was created: Live, Away or Unknown. Applies to both opening channels; for email it describes the Workspace setting, not a form shown to the sender. Show counts and shares of all openings, including Unknown. First-response statistics may be split by the same recorded state. |
| Channel mix at opening | Split window openings into Chat and Email using immutable opening channel. Away-form submissions are Chat openings; subsequent email does not relabel them. Percentages use all openings as denominator. Unexpected/missing historical values appear as Unknown. This is not a message-transport or email-deliverability report. |
| Product breakdown | The same openings and first-response measures grouped by owning Product. Product opening counts sum to the Workspace count for the same range and filters. Workspace percentiles are calculated over all underlying samples, never by averaging Product percentiles. |
| Agent activity | For each human author, count persisted public replies and distinct Conversations they replied to during the window, regardless of opening date or current assignment. Admin-authored replies count too. Notes, status changes, logins and reading are not replies. Multiple replies in one Conversation count as multiple replies but one Conversation for that author. |

A **recorded reply** means the application accepted and persisted a human's
public response; it is not proof the customer received or read it. Internal
notes, acknowledgements, autoresponders, system messages and drafts never
stop a response clock. A persisted email reply whose send subsequently fails
still represents recorded activity; label the metrics “recorded”, explain
this limitation in help text, and preserve the normal delivery-failure UI.
Retries of that same Message never add another reply or reset its timestamp.
No claim of successful delivery can be inferred from this metric.

Use server persistence timestamps, not email sender dates or browser clocks.
For equal timestamps, use stable persisted ordering; equal-time valid replies
produce zero-duration samples. The build must verify existing
`firstAgentReplyAt` semantics before using it as an optimisation: it cannot
substitute for the defined customer-message start or prove delivery. Never
infer historic availability from the current Workspace value.

**Default statistics:** exact median (middle two averaged for even sample
counts) and nearest-rank p90 (`ceil(0.9 × n)` in ascending order). Show the
sample count and “Small sample” below 10 completed samples. Zero completions
means “No recorded replies yet”, not 0 seconds. Unanswered/waiting cases are
excluded from percentiles but always displayed alongside them; this avoids
making an unanswered backlog look fast. A cohort's response metrics may
change when later replies arrive; label them “as of”, not final historical
scores. There are no per-agent response-time rankings.

Agent distinct-Conversation counts are **not additive**: two agents can reply
to the same Conversation. If an overall distinct count is displayed, dedupe
across authors. A removed member with an extant account is labelled “Former
member”; account deletion removes the personal attribution and groups those
replies as “Deleted account”. Neither state grants access or retains a copied
name/email. Do not use these counts as a productivity or quality score.

Live/Away duration, percentage of staffed hours, current online staff and
availability schedules are out of scope. A snapshot at opening answers the
intake question without collecting employee presence or inventing a historic
timeline the application does not currently keep.

## Surfaces and access

**Default:** an authenticated Analytics page in the existing app shell.
Admins see a Workspace overview: date/Product controls, openings trend,
first/follow-up response cards, Live/Away and opening-channel breakdowns,
then Product and agent-activity tables. Use a compact page with readable
numbers and optional charts, not a new dashboard home or custom chart builder.
All charts have equivalent labelled tables; colour is never the only key.
On mobile controls wrap and tables remain usable without clipped labels.

Agents see the same operational Workspace/Product totals and response
summaries plus **My activity**, but not a team member activity list, other
people's activity filters, billing data or Admin configuration. Enforce this
shape server-side; hiding a table is insufficient. Anonymous visitors,
widget sessions and non-members have no analytics access. If future Product
permissions narrow inbox access, analytics must narrow to the same permitted
Products before aggregation, including Workspace totals.

Opening counts may link to the existing inbox with equivalent Product/date
filters only where those filters are supported; otherwise omit the link.
No new customer-content table or customer-level export. Navigating into an
existing Conversation applies its normal authorisation checks.

Show honest states: no Conversations, no completed samples, history not
recorded, partial historical coverage, loading, and query failure with retry.
Never substitute zeros on failure. Show coverage start and “as of” timestamp;
expired or unavailable history is not an empty day. Keep the existing inbox
and message submission usable if analytics fails.

All metrics are private operational information. No public widget response
estimate, “usually replies in …” badge, uptime claim, SLA, public team score,
or marketing-site metric is introduced. Marketing may describe the capability
only after implementation and verification, through its separate copy process.

## App-owned data and aggregation

Use the existing database and tenancy boundary. Start with bounded server
queries over Conversations and minimal Message metadata, adding only facts
that cannot be reconstructed reliably. No event warehouse, new dependency,
queue, cron or separate reporting service is selected by this design.

Logical inputs, not a proposed schema:

- Conversation identity, Workspace/Product identity, original opening time
  and opening channel; minimal customer/agent Message identity, kind, author
  and timestamp for response episodes and activity.
- A server-recorded availability-at-opening fact (Live/Away) for new
  Conversations, captured consistently with the creation operation. Backfill
  only facts supported by durable records. Older availability is Unknown.
- Coverage metadata, definition version and report cutoff. Minimal response
  episode state may be needed for old Conversations whose waiting episode
  crosses the report horizon; read only the predecessor metadata needed to
  reconstruct that state, not an entire customer transcript.

Current main already has Conversation opening timestamps/channel,
`firstAgentReplyAt`, Message kind/author/timestamps and email delivery records.
It lacks historical availability-at-opening. Validate query plans and source
semantics during the build; don't assume an existing field meets the full
metric contract. New metadata collection starts at rollout. A migration may
initialise coverage, but may not label unknown past settings as Live or Away.

Prefer direct aggregation for this first slice, with indexed tenant/date
filters and bounded work. If measured volume requires persisted daily
aggregates, they are replaceable projections of app-owned facts: keyed by
Workspace, Product, UTC day and definition version, deduped by source identity,
with transactional invalidation/rebuild on source change or deletion. Do not
sum daily medians/p90s or per-day distinct counts. Retain sufficient bounded
source samples to compute exact requested-range statistics, or present the
metric as unavailable rather than silently switching to an approximation.
No approximate percentile machinery is a requirement for the first build.

Repeated requests, email webhook retries, reconnects and report rebuilds must
not duplicate facts. Derived reporting work is recoverable; a reporting
failure is surfaced and retried, never acknowledged as a successful refresh.
Do not put expensive aggregation in the message-send path. If minimal extra
capture fails independently, retain the support operation and make the
resulting coverage gap explicit; never fabricate a known availability value.

**Default freshness:** a successful page refresh includes durable changes
committed before its report cutoff, using a consistent database read.
No live chart/SSE subscription. Query timeout yields a visible error; any
previous snapshot remains explicitly dated. If introducing caches later,
keys include Workspace, authorised scope, range, filters and definition
version; membership and deletion invalidate access/results immediately.

### Retention and deletion

**Default:** expose a rolling 90 UTC-date reporting horizon in both modes.
This is a reporting/derived-data limit, not a new retention policy for support
Messages, Conversations, usage or diagnostics. Derive historical measures
within that horizon where existing facts support them; label unknown or
incomplete measures individually. Analytics must not prolong source retention.

Additional analytics facts, samples and any persistent aggregates expire when
their reporting date leaves that horizon. Reads exclude expired material.
Use bounded opportunistic cleanup on analytics reads/writes, following the
existing diagnostics approach; inactive installations may retain hidden rows
until next activity. This is **not** a guaranteed physical deletion deadline.
Do not add a scheduled runner in this slice; see A3 if a deadline is required.
Source metadata needed to reconstruct recent episodes remains subject to its
source's existing retention, not a duplicate analytics archive.

Deleting a Conversation, Contact's owning support records, Product or
Workspace removes its analytics contributions and invalidates derived results;
account deletion removes personal attribution. Archive alone preserves
contributions. Do not keep anonymous-looking lifetime totals as an exception:
small counts and linked dimensions may still disclose information. Deletion
and rebuild must not resurrect removed data; any persisted projections must
be cleared or made unreadable atomically with deletion and rebuilt safely.
Backup retention remains the deployment's existing policy, with restore
procedures reapplying expiry/deletion rules before serving reports.

### Relationship to hosted usage and billing

FR-USE-01 counts a Conversation once ever, in the billing period of its first
opening. FR-USE-02 controls limits and grace behaviour. Neither changes here.
The implementation on this baseline derives usage directly from Conversation
records in `src/lib/usage.ts`; it is not an independent immutable event ledger.
Do not introduce a second definition of billability or replace that module
with analytics aggregates.

For the same Workspace, UTC billing-month window through the same cutoff and
all Products, the openings count must equal current usage over the same
source records. Include archived Products and test Conversations in both.
A Product filter, default 30-day range or restricted history is visibly a
different scope. Reply/episode/activity counts are never billable units.
On hosted Admin views a “Usage & billing” link leads to the existing authority;
self-hosted reports have no allowance, plan, Stripe or hosted API dependency.

Analytics deletion follows source deletion, so historic reports may change.
Current usage also derives from remaining records. Durable billing audit
retention after deletion is a separate usage-policy question (A4), not a
reason for analytics to preserve PII or silently fix/redefine billing here.

## Umami and privacy boundaries

Reuse Umami only for the separate, explicitly configured hosted marketing
pages. Do not reuse its event stream, cookies, script or identifiers for
Workspace support analytics; do not forward first-party aggregates to it.
The marketing Umami configuration (now in the private `supportseal-marketing`
repository) is not this reporting module. Product analytics works with the
Umami environment values unset and with all external analytics hosts
unreachable.

Analytics queries/projections allow only ownership IDs, source IDs needed for
deduplication/deletion, timestamps, Message kind, opening channel,
availability and internal author IDs. Resolve authorised Product/agent display
labels from existing records at read time. Exclude message/note bodies,
subjects, customer names/emails, IP addresses, page URLs, browser fingerprints,
attachments, developer context, diagnostics, email headers, credentials and
free-text tags. Do not copy these into events, logs, caches or error reports.
This is metadata minimisation, not a claim that IDs and timestamps are anonymous.

No browser instrumentation, consent bypass, customer identity linking or
cross-Workspace aggregation is introduced. Normal tenant isolation applies to
aggregates as well as raw data: validate Product ownership before executing
queries, and never accept a caller-supplied Workspace as authority. Logs record
operation/status and bounded diagnostic metadata, not report payloads or PII.

The hosted privacy/data-responsibility text and self-hosted operator guide
should explain operational reporting, staff activity visibility and retention
before release. Their legal wording/approval remains a separate process; this
design makes no claim that a particular notice or consent model is sufficient.

## Defaults and open questions

Defaults for the build: all-plan hosted/self-hosted parity; reporting available
without external opt-in; 30-day view within a 90-date UTC horizon; exact
median/p90 with sample sizes; Live/Away at opening only; Admin team activity
and Agent self-activity; direct database aggregation; no new runner or exports.
These are proposals the maintainer can override, not decisions attributed to the maintainer.

### Open questions

- **A1 — Staff activity visibility/disclosure.** Confirm Admin team activity
  plus Agent self-activity (default), or limit all roles to team totals. The maintainer
  owns that product policy and the release disclosure review; no staff ranking
  or surveillance expansion is implied by accepting the default.
- **A2 — Reporting horizon.** Is a fixed 90-date horizon sufficient, or is
  annual history required? Default 90 dates keeps queries and added metadata
  bounded. Annual reporting requires an explicit retention/performance design,
  not quietly retaining everything during the first build.
- **A3 — Physical purge deadline.** Accept hidden-until-opportunistically-purged
  expired analytics rows (default), or require a guaranteed purge schedule?
  The latter needs the maintainer's infrastructure/retention decision before adding a
  runner. Do not describe the default as deletion within 90 days.
- **A4 — Billing audit after deletion (separate usage policy).** Should hosted
  usage preserve a minimal audit record after source deletion, and with what
  retention? No answer is invented here. Default for this slice is to preserve
  existing usage behaviour and reconcile against its current sources. A
  different billing policy must be separately scoped and decided.

## Acceptance criteria for the later build

These IDs define this proposed slice; they do not assert existing functionality.

- **AN-01 Access.** Admin can read their Workspace's full report; Agent can
  read operational totals and self-activity only. Direct requests for another
  agent's activity, another Workspace/Product, or use of a widget session
  cannot reveal protected results, counts, cache entries or existence.
- **AN-02 Openings and usage.** Seed two Products, including an archived
  Product and a test Conversation. Compare all-Product openings for the UTC
  billing month to `computeUsage` at the same cutoff. Close/reopen, continue by
  email next month and replay intake: none adds another opening or billed unit.
- **AN-03 Response episodes.** Fixture: customer at 10:00, customer at 10:02,
  note at 10:03, agent at 10:05, customer at 10:10 and 10:12, agent at 10:20.
  First response is 5 minutes; one follow-up episode is 10 minutes. Another
  unanswered customer at 10:30 remains waiting, excluded from percentiles.
  Closing/reopening and automated messages do not reset/stop the clocks.
- **AN-04 Cohorts and statistics.** First response uses opening cohort;
  follow-up uses episode-start cohort; agent activity uses reply timestamp.
  Cover replies after the selected end date but before “as of”, old
  Conversations with recent episodes, equal timestamps, negative/invalid
  intervals, odd/even medians, nearest-rank p90, zero and small samples.
- **AN-05 Honest reply semantics.** Failed email delivery remains labelled as
  a recorded reply, never delivered/read. Retrying the same Message does not
  add activity. Notes, drafts and autoresponders do not count as human replies.
- **AN-06 Availability and channel.** Create openings in Live and Away,
  including inbound email and away forms; change the current setting and
  continue chat by email. Historic availability/channel remain unchanged.
  Pre-rollout availability is Unknown, included in the denominator.
- **AN-07 Rollups.** Product opening totals sum to Workspace totals. Two
  agents replying to one Conversation produce two author-level distinct
  counts but one overall distinct Conversation. Workspace percentiles match
  raw samples rather than averages of Product/day percentiles.
- **AN-08 History and boundaries.** UTC midnight, month/year boundaries,
  custom ranges and the rolling horizon obey the half-open interval contract.
  Missing coverage, excluded invalid data and expired history are labelled;
  they never become fabricated zero counts or known availability.
- **AN-09 Deletion and privacy.** Delete source Conversations, Products,
  Contacts' records, Workspaces and accounts; reports/caches lose their
  contributions or personal attribution as specified. Rebuild cannot restore
  them. Canary customer content, emails, URLs, context and diagnostics never
  appear in analytics projections, responses or logs.
- **AN-10 Recovery and bounds.** Duplicate source delivery/rebuilds leave
  counts unchanged. A reporting query failure produces retry UI and does not
  break the inbox. Expired derived facts are unreadable and cleanup is bounded.
  Demonstrate tenant/date query plans on a realistic multi-Product fixture,
  recording row volume and latency; no unbounded transcript scan is acceptable.
- **AN-11 Hosting parity.** Browser flows pass in both modes without Umami
  configuration. Self-hosted reports make no external telemetry, hosted API
  or billing requests. Configured marketing Umami gains no dashboard/widget
  instrumentation or customer/report event payloads.
- **AN-12 Surface and documentation.** Browser-check desktop/mobile,
  keyboard controls, chart/table equivalence and empty/loading/error/partial
  states with realistic data. Inbox stays the landing page; no public metric
  badge appears. Add V2 FRD references, architecture clarification and operator
  documentation; keep unshipped/public promises separate.

Build verification: unit tests for metric fixtures; PGlite integration tests
for scoping, role-shaped responses, usage reconciliation, expiry/deletion and
rebuilds; hosted/self-hosted critical-path E2E plus independent review. Run the
repository's full verification for this analytics implementation and capture
browser evidence. After deployment, smoke the authorised report, usage
reconciliation and self-hosted independence. This design-only change does
not run or claim those future acceptance tests.
