# Verified custom sending domains — V2 design

Status: proposed V2 design, 2026-10-01. Defaults below are working choices
the maintainer can override, not approved product decisions. No V1 behaviour changes.
Based on `main` at `0048aa8`, [PRD: Later](../PRD.md#later-and-outside-scope),
and [ADR-0004](../adr/0004-email-boundary.md).

## Goals and boundary

Let a Workspace Admin verify a domain they control and give each Product a
recognisable outbound identity, including `Support <support@myproduct.com>`.
Keep setup understandable without requiring email expertise. Agents must know
which address a customer will see and whether a reply actually left the system.
Preserve secure conversation threading, tenant isolation and provider independence.

V1 remains the default: `"{Product} Support" <{managed sender}>`, using the
configured managed domain and SendGrid on hosted installations. Existing Products
migrate to managed mode with no DNS work. V2 is opt-in for customer replies,
including chat-to-email continuation. System/auth mail and inbound rejection
notices retain the instance-managed sender.

Non-goals: a mail server, enterprise CRM/workflows, marketing campaigns, arbitrary
From addresses, per-Product SMTP accounts, mailbox hosting, inbound custom MX
setup, or a new inbound routing scheme. Website/widget domain allowlists do not
prove sending-domain ownership. Verifying a sender does not create a mailbox,
configure forwarding, or guarantee inbox placement.

## Product surfaces

### Product settings → Email

Extend [product-settings.md](product-settings.md)'s outbound section; retain its
Inbound instructions and Delivery problems link. Clearly separate **Receiving
email** from **Sending email**. The optional inbound support-address field remains
display-only and cannot authorise a From address.

The Sending email card shows mode (**Managed sender** / **Custom sender**), exact
From preview, verification badge, last successful check and **Set up custom
sender** or **Manage sender**. Managed is initially selected. Only Admins can
configure it; Agents get a read-only summary in the inbox. Archived Products
remain viewable but cannot activate or send; unarchiving requires a fresh check
before resuming custom sending.

Example after activation:

```text
Sending email                            Custom sender · Ready
From: Acme Support <support@myproduct.com>
Reply-To: Conversation reply address (managed by this installation)
Last checked: 2 minutes ago               Manage sender
```

Use central brand configuration in implementation copy, existing `--vx-*` tokens,
Card, Badge, Alert, Input, CopyButton and Dialog patterns. Status always has text,
not just colour. Narrow screens stack DNS fields with selectable, wrapping values.
Keyboard users can complete the wizard; focus moves to step headings/errors and
status updates use a polite live region without stealing focus.

### Verification wizard

A resumable section within the Email tab, with explicit actions rather than
implicit activation on Save:

1. **Choose sender.** Enter an exact domain (`myproduct.com` or
   `mail.myproduct.com`), local-part and display name. Preview the full address.
   Explain that DNS access is required and new mail to this address still needs
   a real mailbox/forwarding arrangement. Existing verified domains belonging
   to this Workspace may be reused. Creating a domain saves a pending setup;
   leaving the wizard does not change the active sender.
2. **Add DNS records.** Show Type / full Host / Value / Status, with independent
   copy buttons and guidance for DNS consoles that append the zone name.
   Present required ownership, DKIM and return-path records; show SPF and DMARC
   explanations separately. “These records authorise sending; keep your existing
   mailbox MX records.” An occupied return-path hostname needs another unused
   subdomain, never an instruction to overwrite existing records.
3. **Check records.** **Check again** runs a bounded server-side check, showing
   each record's result, last attempt and next allowed retry. Missing/mismatched
   records say what to correct; propagation is “Waiting for DNS”, not a broken
   Product. A provider outage says “Couldn't check; try again” and preserves
   progress. Do not promise a fixed propagation time or claim a timeout means
   the record is absent.
4. **Review and activate.** Show exact From, unchanged Reply-To behaviour and
   affected Product. **Use this sender** is enabled only after all required
   checks pass. Activation revalidates eligibility on the server. Offer an
   explicit test email to the signed-in Admin's verified account address;
   it uses the same sender resolver/transport and reports acceptance separately
   from delivery. Do not send tests automatically or accept arbitrary recipients.

**Replace sender** keeps the active sender while a replacement is prepared;
activation swaps atomically. **Use managed sender** requires an explicit Admin
save. **Remove domain** lists affected Products and requires those Products to
switch to managed mode or another ready domain first. Explain that DNS records
remain at the customer's DNS host; only suggest removal once no Product uses
that provider registration. Provider cleanup failures remain visible and retryable.

### Conversation and email views

Extend [conversation-view.md](conversation-view.md)'s channel hint with
`From: Acme Support <support@myproduct.com> · Custom sender` whenever the reply
will go by email. No sender picker for Agents. Managed mode says “Managed sender”;
a pending candidate does not obscure the current working sender. Notes and live
chat do not show an email warning unless an email continuation is being attempted.

If the selected custom sender becomes unusable, show “Email paused: sender needs
attention”; preserve the draft and block email dispatch. Admins get **Fix sender**;
Agents see “Ask a Workspace admin to check Email settings.” No silent fallback to
the managed address. Before first activation, managed sending continues normally.
If another Admin changes the sender while a draft is open, reject the stale send
with a refreshable preview; require the agent to send again with the new identity.

Email cards show the From snapshot used for that attempt, not today's settings.
Delivery failures remain attached to the message and visible in the inbox's
attention indicator and Product's existing 30-day Delivery problems view. A sender
warning concerns configuration; a bounce concerns a particular delivery/recipient.

## DNS contract and eligibility

The following is the proposed application policy, deliberately stricter than mere
provider permission to submit mail. Domain matching is exact; verifying the apex
never authorises arbitrary subdomains or wildcard From addresses.

| Record | Requirement and presentation |
| --- | --- |
| Ownership TXT | App-generated random challenge at `_supportseal-verification.<domain>`, scoped to the Workspace and domain registration. Required even if the provider already recognises the domain. Show the exact token; retain it while sending. Store a hash for comparison, and rotate on ownership transfer/re-registration. |
| DKIM | Show the provider's exact selector/host and value. Require current DNS evidence for the active signing key and provider acceptance. A pending rotation is separate: keep the valid active key until the provider switches; only advise deletion of retired keys when safe. |
| Return-path | Require the provider-specific bounce-domain setup. Hosted default: an unused return-path subdomain CNAME to the provider-returned target. Store the host SendGrid returns (its generated subdomain carries random digits, e.g. `em1234`); never assume plain `em.<domain>`. It routes delivery failures, not customer replies. |
| SPF guidance | SPF authenticates the envelope/return-path domain, not the visible From alone. The provider's return-path handles SPF; do not demand a second apex SPF TXT or use a provider-reported SPF flag as a readiness gate. Other SMTP providers may require an include in an existing SPF policy: follow their instructions, never replace unrelated senders or create multiple SPF policies at one hostname. |
| DMARC guidance | Explain that aligned DKIM and/or SPF support the customer's DMARC policy. Preserve existing policy; do not auto-publish or weaken it. A custom return-path subdomain does not satisfy strict SPF alignment with the apex; aligned DKIM remains important. No DMARC reporting product in this slice. |

SendGrid provides domain records through its Domain Authentication API. A
provider-reported "verified" flag can lag or outlive the DNS record, so it is
not current DNS health evidence. Use fresh DNS observations as well as provider
results. Confirm the exact API behaviour against SendGrid's documentation when
the capability is built.

### State and retry rules

Store registration state separately from a Product's selected sender mode. A
verified unused domain is **Ready**, not automatically **Active**.

| State | Meaning / next action | Custom dispatch |
| --- | --- | --- |
| Provisioning | Durable local registration exists; provider setup incomplete; retry/reconcile the same operation | Blocked |
| Pending DNS | Required evidence missing or mismatched; correct DNS and Check again | Blocked |
| Ready | Ownership, active DKIM, return-path and provider checks passed | Allowed if selected and evidence fresh |
| Needs attention | Previously ready; confirmed DNS removal/mismatch, revoked permission or provider rejection | Blocked; fix and recheck |
| Check unavailable | DNS/provider check timed out or was rate-limited; retain previous evidence and explain uncertainty | Only if prior ready evidence remains fresh |
| Removing | Locally disabled; provider cleanup pending | Blocked |

Defaults: checks coalesce per domain, manual retry at most once per minute, with
per-Workspace limits and provider `Retry-After` respected. Save sanitised error
codes and timestamps. Rate limits never create a new provider domain. A failed
check can return to Ready without recreating the setup once evidence passes.

Treat successful evidence as fresh for at most 24 hours. On a settings check or
send with stale evidence, recheck via bounded server-side calls; if unavailable,
block with a retryable error. A confirmed failure blocks immediately even inside
that window. This bounds undetected DNS removal to the cache window; it is not
continuous monitoring. No new cron/queue infrastructure is assumed. DNS resolvers
must distinguish NXDOMAIN/mismatch from timeout/SERVFAIL and respect record TTLs
within the freshness cap. Successful repair restores eligibility, not automatic
resending of failed messages.

## Hosted and self-hosted operation

**Hosted:** provision/check domains through a provider capability behind
ADR-0004. Keep the account-management API key in server-side deployment secrets,
separate from the Mail Send-only `SENDGRID_API_KEY`. Do not expose account-wide
provider listings to tenants. The application enforces ownership even though
provider credentials can authorise multiple domains. Platform-managed domains
and system identities cannot be claimed by a Workspace.

**Self-hosted with SendGrid:** the operator supplies their own sending credentials,
account-management credential if automated provisioning is wanted, and authenticated
outbound webhook configuration. No hosted service, Stripe or telemetry is required.
Without management credentials, use the operator-managed path below; a server
send token alone does not enable domain provisioning.

**Self-hosted with another SMTP provider:** retain server-only `SMTP_URL`. The
operator configures their provider's domain approval, DKIM signing, envelope
return-path, SPF and bounce/event routing. A proposed server-only domain registry
maps exact allowed domains to provider-required public DNS records and an operator
attestation of provider approval. This is a new V2 configuration contract, not an
existing environment variable. The application checks its ownership challenge and
those DNS records; Admins may select only registered domains. Label the source
“Operator configured”, and explicitly show whether delivery events are connected.
Do not claim that DNS alone proves an SMTP relay signs correctly: acceptance
requires an operator test with received authentication headers. Unsupported relay
capabilities keep custom mode unavailable with actionable operator instructions.

Generic SMTP has no universal bounce webhook. Require either an adapter to the
normalised event contract or a documented operator-monitored bounce mailbox with
a tested failure path; in the latter case the app says “Accepted by relay; delivery
tracking unavailable”, never “Delivered”. No in-app mailbox reader is added.
SMTP credentials, private DKIM keys and provider account tokens never go through
browser forms or browser responses. The operator may keep using the configured
managed sender if custom setup is unavailable. Existing inbound forwarding and
webhook instructions in [self-hosting.md](../self-hosting.md) still apply.

## Data model and API sketch

Names are proposed, not a migration. Keep sending-domain records separate from
`ProductDomain`, which currently controls widget access.

| Entity | Proposed fields / constraints |
| --- | --- |
| SendingDomain | Workspace ID, canonical ASCII domain, provider/account configuration reference (no secret), provider domain ID, state, ownership token hash, expected public records, per-record observations, checked/verified timestamps, last safe error, version, created/removed timestamps. Active domain claim unique across Workspaces within the installation; multiple Products in the owning Workspace may reuse it. |
| ProductSender | Workspace/Product IDs, mode `MANAGED` or `CUSTOM`, selected domain ID, local-part, display name, version. One active identity per Product; optional pending replacement. Composite ownership constraints prevent cross-Workspace references. |
| Delivery attempt | Extend the existing `EmailDelivery` ledger or add attempts beneath its unique agent-message row: sender snapshot/version, domain reference (nullable after removal), RFC Message-ID, provider delivery ID, provider/account/stream reference, attempt state, safe failure reason and timestamps. Preserve threading semantics and historical From after settings changes. |
| Delivery event | Provider/account/event identity, correlated attempt, normalised type, received/event timestamps, processing outcome. Unique event identity for deduplication; minimal payload retained. |

A registration's canonical domain uses lowercase IDNA ASCII with a display form;
reject URLs, ports, paths, IPs, wildcards, public suffixes and header/control
characters. Local-parts initially use a bounded ASCII dot-atom subset (no quoted
addresses, consecutive/edge dots or CR/LF); preserve validated spelling. Display
names are length-bounded and escaped by the existing header safety boundary.

Proposed authenticated routes (path names illustrative):

| Route | Contract |
| --- | --- |
| `GET /api/products/:id/sender` | Admin/Agent: safe effective sender summary and version; scoped to accessible Product |
| `GET /api/sending-domains` | Admin: current Workspace only, public DNS instructions and state |
| `POST /api/sending-domains` | Admin: create/reuse an owned registration; idempotency key; never accept provider IDs or claimed verified state |
| `POST /api/sending-domains/:id/check` | Admin: bounded check; return normalised observations and retry time |
| `PUT /api/products/:id/sender` | Admin: select managed/custom and validated identity; expected version; atomic eligibility check |
| `POST /api/products/:id/sender/test` | Admin: rate-limited explicit test to their verified account email |
| `DELETE /api/sending-domains/:id` | Admin: refuse while referenced; disable locally before retryable provider cleanup |
| `POST /api/email/events` | Provider-authenticated delivery/bounce events; no browser/session trust |

Derive Workspace from session membership, never body fields. Authorise both
Product and domain on every lookup/mutation, and recheck at dispatch; arbitrary
From/Reply-To supplied by a client is rejected. Agents cannot add, verify, remove,
activate or edit identities. Cross-Workspace IDs yield non-disclosing not-found
responses; conflicts never identify another owner. Use existing CSRF/origin
protections, optimistic concurrency and audit records for Admin actions.

Persist provisioning intent before external calls. Reconcile ambiguous provider
creation by canonical domain within the configured account before retrying;
never attach an existing domain to a new tenant solely because the provider
accepts it. Concurrent claims must have one winner. Deleting a Product removes its
binding, not a shared domain. Domain deletion never deletes historical messages
or delivery evidence; provider resources must not be removed if still shared.
Reassignment needs fresh ownership proof and explicit release, not “first DNS
check wins”. DNS lookups and provider calls use fixed protocols/endpoints with
bounded timeouts/results; customer input cannot become an arbitrary fetch URL.

## Delivery, bounce handling and adapter changes

The current [outbound resolver](../../src/lib/email/outbound.ts) always builds a
managed From. Resolve V2 sender identity there from trusted Workspace/Product
state before either SendGrid or SMTP submission. Preserve reply-token Reply-To,
In-Reply-To and References; existing inbound adapters and routing stay unchanged.
A changed sender must not split an existing conversation or affect billing counts.

The [SendGrid adapter](../../src/lib/email/providers/sendgrid.ts) returns only the
RFC Message-ID today; it must also retain the provider's own message ID from the send response.
Keep these as separate identifiers: threading uses the former; provider events correlate by
the latter. Extend the transport result without repurposing historical
`providerMessageId` values. Legacy rows without a provider delivery ID cannot be
reliably correlated retrospectively and must not be guessed from an email address.

Add a separate provider-neutral domain-management capability and normalised
outbound-event parser alongside the existing send/inbound seams. The event
handler authenticates before parsing, maps provider/account plus delivery ID to
a stored attempt, and derives tenant ownership from that attempt. Never trust
Workspace/Product IDs in event metadata as authorisation. Verify the provider's
event signature where it offers one; otherwise use HTTPS and a dedicated outbound
webhook credential, with constant-time secret comparison and redacted logs.
Deduplicate bounce events using their provider bounce ID scoped to the account;
persist before acknowledging. Unknown/early events are quarantined for bounded
reconciliation, without changing any tenant's messages.

Submission acceptance is not delivery. Represent **Accepted**, **Delivered** only
with evidence, **Bounced**, **Blocked before send**, and **Outcome unknown**.
Preserve events arriving out of order; a later delivery event cannot erase a
terminal bounce for that attempt. Hard bounces/complaints suppress further sends
as required by the provider; never auto-reactivate or bypass suppression by
switching From. Apply provider-scoped suppression without leaking other tenants'
recipient history. A recipient bounce does not revoke a domain's verification.

For transient rejection before acceptance, allow explicit Retry after rechecking
sender and recipient eligibility. For accepted soft bounces, respect provider
retry/finality; disable manual resend while provider delivery is pending. For a
timeout after submission or persistence failure after provider acceptance, show
Outcome unknown and reconcile before another send. Do not assume the provider offers
request idempotency: a locally unique message row alone cannot prevent duplicate
external sends. Persist/claim attempts before dispatch, serialize concurrent
retries, and do not resend a known accepted attempt. Retrying an eligible terminal
failure creates a new auditable attempt under the same agent message, with a new
RFC Message-ID and current sender preview. No automatic message resend on repair.

The existing `sendBounce` is an inbound rejection notice, not outbound bounce
processing. It retains its current sender and purpose. Provider bounce content
must not be ingested as a customer reply or produce a bounce loop.

## Defaults and open questions

These defaults allow a later build to proceed; the maintainer may override them. They
are indexed in [open-questions.md](../open-questions.md#v2-sender-domain-design).

| ID | Question for the maintainer | Working default and trade-off |
| --- | --- | --- |
| SD1 | One domain per Product or many selectable senders? | One active identity/domain per Product, with one staged replacement; reuse a Workspace-owned domain across Products. Keeps dispatch unambiguous; multiple selectable identities deferred. |
| SD2 | Default local-part and display name? | `support`; retain `{Product} Support` as the name. Admin may set `Support` or another safe Product label. Managed defaults remain unchanged. |
| SD3 | Can Agents override From? | No, including Admins acting in the composer. Identity changes happen in Product settings. Avoids accidental spoofing and per-reply policy complexity. |
| SD4 | Retain failed verification attempts for how long? | Expire never-activated setups after 30 days without Admin activity; show expiry date. Keep minimal failed-check/audit metadata 30 days, then remove it. Successful bindings are not aged out; delivery history follows existing deletion rules. Cleanup can run on access using timestamps; release provider resources only after safe reconciliation. No new scheduler assumed. |
| SD5 | What happens when an active sender fails? | Pause email; Admin explicitly selects managed or repairs. No silent fallback. More visible interruption, but sender identity stays predictable. |
| SD6 | How strict is readiness/freshness? | Ownership TXT + current DKIM + custom return-path, fresh within 24 hours. More setup than the provider minimum; bounds stale authorisation. |

**Open before hosted rollout (maintainer/operator decision):** confirm that the intended
SendGrid account/subuser arrangement and provider approval cover multi-tenant
customer-domain sending and the expected domain volume. Choose shared versus
isolated provider resources based on actual account constraints; do not invent a
provider limit or promise per-tenant reputation isolation. Until confirmed, the
design can be built/tested against fakes and an operator-controlled test domain,
but hosted custom-domain activation must not be enabled. Pricing/plan gating is
not decided here; no paid-tier restriction is implied by this design.

## Acceptance criteria for the V2 build

1. **SD-AC-01 — V1 preservation:** existing Products keep the same managed From,
   system mail, reply routing and archived behaviour after migration; no DNS
   setup is required. Custom setup cannot change widget domain permissions.
2. **SD-AC-02 — Wizard:** an Admin completes keyboard and narrow-screen flows
   with realistic DNS values; copy errors leave values selectable. Missing TXT,
   bad DKIM, return-path conflict, provider timeout and rate limit each show an
   actionable state and preserve input. Resume/repeated Check creates no duplicate
   registrations. No activation occurs merely because DNS becomes ready.
3. **SD-AC-03 — Authorisation:** tests with two Workspaces and Admin/Agent roles
   cover every route, domain reuse, concurrent claims, forged provider IDs,
   activation and dispatch. Agent mutations and cross-tenant references fail;
   secrets and other tenants' domains never appear in responses/logs.
4. **SD-AC-04 — Verification:** fake DNS/provider tests cover exact domain matching,
   expired evidence, a provider-reported verified flag with removed DNS, rotated keys,
   DNS transient failures, ownership token replay and revoked permission.
   Pending/invalid custom identities cannot send. Header injection is rejected.
5. **SD-AC-05 — Identity:** a real test-domain email arrives with the configured
   From, expected DKIM/SPF/DMARC authentication results and preserved Reply-To;
   a customer reply returns to the original Product/conversation. Changing From
   does not change threading or historical cards. Stale composer versions require
   a refreshed preview before sending. No secret is sent to the browser.
6. **SD-AC-06 — Lifecycle:** replacement leaves the old ready sender usable until
   atomic activation; invalidation pauses custom email without losing drafts;
   repair does not resend. Shared domain removal is refused while referenced;
   cleanup failures and expired pending setups reconcile without orphan claims.
7. **SD-AC-07 — Delivery:** authenticated duplicate, early and out-of-order bounce
   fixtures update exactly one correct attempt/tenant. Wrong secrets and unknown
   IDs cannot mutate delivery state. Hard bounce/suppression disables resend;
   soft bounce policy, transport timeout, DB failure after acceptance and
   concurrent Retry cannot blindly duplicate mail. UI never equates accepted
   with delivered. Inbound rejection notices remain separate.
8. **SD-AC-08 — Hosting parity:** exercise operator-owned SendGrid and independent
   SMTP paths with no hosted API/Stripe dependency. Missing management capability
   gives operator instructions; missing transport never marks a custom test as
   delivered. For SMTP, verify received authentication headers and either event
   correlation or the documented monitored-bounce path; show tracking limitations.

Implementation verification: repository lint, typecheck, unit/integration tests
and build; browser smoke/visual evidence for wizard and conversation states;
critical email/threading and cross-Workspace E2E plus independent security review.
Use controlled test recipients/provider fixtures for bounce tests. Post-deployment
smoke must confirm the configured provider path before customer rollout.

## Relationship to existing documents and implementation

This is the scoped long-term extension of ADR-0004, not a replacement mail stack.
A later implementation should add capability contracts and tests behind the
boundary, update self-hosting configuration docs, and explicitly extend the two
V1 UI designs only for custom mode. PRD/FRD V1 requirements remain intact. No
schema, environment setting, adapter behaviour or UI described here ships with
this documentation commit.

It does not fix unrelated outbound persistence/retry issues in V1; the attempt
handling above is a prerequisite when building this V2 delivery path. Main added
risks are account-token privilege, domain-claim takeover, stale DNS evidence and
duplicate external delivery; the scoped ownership checks, evidence expiry and
attempt reconciliation address them. Provider account limits and real-world
SMTP authentication still require operator validation.
