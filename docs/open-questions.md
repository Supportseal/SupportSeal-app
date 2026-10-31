# Open questions

Decisions that need the maintainer, with options and source references. In the
numbered questions, nothing is decided unless it is marked **Resolved**;
never treat an option as an answer. When a question is resolved, move the
outcome into the owning document (PRD/FRD/architecture/ADR/design doc) and
mark the entry **Resolved** with the maintainer's answer and date. Entries marked
**Default** in "Design decisions" are working choices made on the maintainer's behalf.
They apply until the maintainer overrides them; an override updates the listed docs.

## Design decisions (2026-09-25)

Questions raised by the V1 design docs (`docs/design/`). Numbers follow the
design review list.

### Resolved by the maintainer

| # | Question | The maintainer's answer | Recorded in |
| --- | --- | --- | --- |
| D1 | Away mode scope | **Resolved:** one Workspace-wide Live/Away setting, not per Product | FR-CHAT-04; `design/app-shell.md`, `chat-widget.md` |
| D2 | Email to an archived Product | **Resolved:** it bounces | FR-PROD-01; `design/product-settings.md`, `support-inbox.md` |
| D3 | Reply to a Closed Conversation | **Resolved:** a customer or agent reply reopens the same Conversation; no new Conversation; it is counted once ever for billing (also resolves question 2 below) | FR-INBOX-02, FR-USE-01, architecture.md; `design/support-inbox.md`, `conversation-view.md`, `chat-widget.md` |
| D6 | Who deletes Conversations and Products | **Resolved:** Admins only | FR-ACC-01; `design/conversation-view.md`, `product-settings.md` |
| D9 | Page URL capture | **Resolved:** the widget records the page URL automatically | FR-CTX-01/02; `design/chat-widget.md`, `conversation-view.md` |
| D12 | Branding | **Resolved:** mint green; full palette, tokens and logo direction delegated to the design pass | `design/brand.md` |

### Defaults (the maintainer can override)

| # | Question | **Default** chosen | Why | Recorded in |
| --- | --- | --- | --- | --- |
| D1a | Who can toggle Live/Away | **Default:** Admins only; Agents see the status read-only | Workspace-wide change affects every Product; matches Admin ownership of channel settings (FR-ACC-01) | `design/app-shell.md` |
| D6a | Who manages saved replies | **Default:** Admins create, edit and delete; every role inserts them. A reply is All-products or scoped to one or several Products (issues #139, #200); the composer offers All-products replies plus those whose selection includes the conversation's Product, and admins can save the current draft as a reply from the composer | FR-INBOX-02 says "managed" saved replies; keeps one curated set | `design/app-shell.md`, `conversation-view.md` |
| D4 | Agent name vs "{Product} Support" | **Default:** customers see "{Product} Support" in the widget and as the email sender name; the dashboard shows which agent replied | Keeps Product identity primary (FR-EMAIL-02) and avoids exposing staff names | `design/chat-widget.md`, `conversation-view.md`, `product-settings.md` |
| D5 | When a chat reply goes out by email | **Default:** email-started → email. Chat with the visitor's widget connected (stream or heartbeat within 60s) → chat. Visitor not connected and email known → email, also stored in the chat thread. No email → chat only, with a warning. The agent can override when both are possible | Delivers replies where the visitor actually is (FR-EMAIL-02) | `design/conversation-view.md` |
| D7 | Domains vs allowlist; subdomains | **Default:** one "Allowed domains" list serves as both; exact hostname match; explicit `*.example.com` covers subdomains but not the apex; localhost is a separate switch | Simplest model that satisfies FR-CHAT-01 without surprise access | `design/product-settings.md`, `onboarding.md` |
| D8 | Hosted test page security | **Default:** an Admin-only, signed, single-Product test token (30 minutes) lets the SupportSeal-hosted test page load that Product's widget. No allowlist entry is added; the token grants only a normal visitor session. Test Conversations get an automatic "test" tag and count for usage normally. Security review required in the widget PR | Avoids a blanket origin exception (FR-CHAT-01, FR-SEC-01) | `design/onboarding.md`, `chat-widget.md` |
| D10 | Widget size budget | **Default:** loader ≤ 5 KB gzip; panel app ≤ 50 KB gzip JS on first open (excluding images/attachments); both reported in the widget PR | Widget size is a critical performance area | `design/chat-widget.md` |
| D11 | Archive before delete | **Default:** a Product must be archived before it can be deleted (Admins only, typed-name confirmation). Conversation deletion needs only a confirmation dialog | Two deliberate steps for the most destructive action | `design/product-settings.md` |
| D2a | Replying in an archived Product's Conversations | **Default:** read-only until the Product is unarchived (notes, tags and status still work) | Customer replies would bounce and the widget no longer loads, so replies could not continue | `design/conversation-view.md`, `support-inbox.md`, `product-settings.md` |
| D9a | Which part of the page URL | **Default:** origin plus path; query string and fragment stripped; developers may send a full URL via `context()` | Query strings often carry tokens or emails (FR-SEC-02) | `design/chat-widget.md`, `conversation-view.md` |
| D13 | Generated inbound address and `inboundEmailVerified` semantics | **Default:** every new Product gets an auto-generated `product_<random>@<inbound domain>` address (unique, allocated at create) and `inboundEmailVerified` is stamped at the same moment — the platform issued the address, so no customer proof is needed. Inbound routing only accepts verified addresses (issue [#10](https://github.com/Supportseal/SupportSeal-app/issues/10)); any future non-generated address stays null until proven. "Receiving" status still derives from inbound deliveries (issue [#6](https://github.com/Supportseal/SupportSeal-app/issues/6)) | Keeps the checklist's "first inbound email received" proof honest and gives the flag a real job without a provider flow (`design/onboarding.md` open point) | `design/product-settings.md`, `design/onboarding.md` |
| AA22 | What `savedReplyId` means on `createMessage` (slice 1d) | **Default:** validated, never expanded and not stored. It must name a Saved Reply of the token's Workspace (a foreign or unknown id is the uniform 404); the API never substitutes text, the client sends the final `body`, and the Message keeps no link to the Saved Reply (storing one needs a column, a follow-up if wanted). Alternative: expand the Saved Reply server-side when `body` is omitted | The plan lists the field but not its effect; substituting text server-side would let a client send a reply it never saw | FR-API-04; `openapi.json` (`createMessage`, `MessageCreate`) |
| AA23 | How `createMessage` reports delivery (slice 1d) | **Default:** the email is attempted inside the request, so the outcome is known: `sent`, `failed` (the Message stays stored, the failure is on the delivery ledger and the request still returns 201, because a retry would not help and the key would replay it) or `not_applicable` (chat-only reply, or a note). `queued` is reserved for asynchronous delivery and is not emitted. Alternative: deliver after the response like the dashboard and always answer `queued` | An agent needs to know whether the customer was emailed, and the request is the only place it can learn that; the dashboard defers delivery with `after()` because a person is waiting on the page, which an API caller is not | FR-API-04; `openapi.json` (`createMessage`, `Message.delivery`) |

## Inbox ordering and close-advance (issue #199, 2026-10-19)

Raised by [issue #11](https://github.com/Supportseal/SupportSeal-app/issues/11):
the inbox listed newest-activity-first and closing an open thread left the
agent on the finished conversation. Working defaults the maintainer can
override:

| # | Question | **Default** |
| --- | --- | --- |
| OQ1 | List ordering | **Default:** every tab (Open/Pending/Closed, search included) lists Conversations by `createdAt` ascending — oldest first, stable: replies never reorder the queue. Alternative considered: `lastMessageAt` ascending. Creation order makes the queue read top-down as a workload. |
| OQ2 | Close-loads-next | **Default:** closing the conversation open in the conversation view auto-selects the next Conversation in the same tab's order; when the closed one was last, the empty state shows; when the next page of the list cannot be loaded, the conversation still closes and the agent stays on it with a notice (never the empty state). Same behaviour on desk and phone. Closing from the list keeps the current behaviour (no navigation). |

## Keyed contact-form endpoint (issue #154, 2026-10-13)

Raised by [issue #9](https://github.com/Supportseal/SupportSeal-app/issues/9)
(CheckID feedback): the widget API is browser/cookie/Origin based, so a
website's server could not hand a contact-form submission to a Product with
a key — the site's workaround (a contact form that emails the Product's
inbound address) attributes the ticket to the sender and agent replies
never reach the visitor. The implemented direction: a keyed server-side
"form submission" endpoint that creates a Conversation with an explicit
contact email. These are working defaults, not resolved policy approvals.

| # | Question | Working position |
| --- | --- | --- |
| KQ1 | Secret or public key semantics? | **Default:** a per-Product *public* form key (`fk_…`, same entropy as the widget key) stored like `widgetPublicKey` and shown in the dashboard. It is meant to stay on the customer's server (unlike the widget key it is not embedded in page HTML), but is treated as public-unguessable because possession authorises posting — the trust model of inbound email's From, not of an origin gate. |
| KQ2 | Rotation semantics? | **Default:** immediate single-key rotation (Admin-only, refused while archived): the previous key stops authorising submissions at once, no overlap window. A leaked key is cut off immediately; sites accept a brief outage while updating. |
| KQ3 | Rate limiting? | **Default:** an IP-only in-process bucket (30/min, like the session-mint cap #81) charged before any database access; each accepted post creates a Conversation, and key- or token-keyed buckets are meaningless because the key identifies the Product, not a client. |
| KQ4 | Channel and contact semantics? | **Default:** conversations open as CHAT with the explicit email upserted as the contact (like the away form); replies follow the normal reply-routing rules (D5). Anyone holding the key can attribute a conversation to any email — identical trust to inbound email; documented in the Developer tab copy. The one exception (PR review): the Product's own support/inbound addresses are rejected with a 400 like the widget email capture — replies to them would re-ingest (mail loop). |
| KQ5 | Intake atomicity? | **Default (PR review):** the Conversation and its first message are created in one interactive transaction (`createConversationWithFirstMessage`), so a crash mid-intake cannot strand an empty Conversation that usage metering already counted. The contact upsert stays outside that transaction (same as inbound email): a surviving contact row is not an orphan. |

## Ticket numbers (issue #141, 2026-10-11)

Decided by the maintainer (2026-10-10, [#8](https://github.com/Supportseal/SupportSeal-app/issues/8)): a persistent, monotonic per-Workspace number on every Conversation, shown in the widget thread, inbox and outbound email subjects, never used for threading. Implementation defaults the maintainer can override:

- **Allocation.** A counter on the Workspace row (`nextTicketNumber`) is incremented inside the Conversation-creating transaction; the row lock serialises concurrent creators on any Postgres, with no sequence object per Workspace and no external service. `UNIQUE (workspaceId, ticketNumber)` is the backstop. A rolled-back creation (for example a duplicate inbound webhook) releases its number; a committed Conversation's number is never reused, even after deletion.
- **Format.** `SS-<n>` with no zero padding (`TICKET_PREFIX` in `src/lib/ticket.ts`; display only, so changing it never touches stored data). Self-hosters who rebrand currently edit that constant; making it configurable is a follow-up, not decided here.
- **Wording.** The PRD keeps the interface from saying "ticket", so the widget labels it "Reference SS-123" and the inbox shows the bare `SS-123`.
- **Email subject.** Outbound subjects become `Re: [SS-123] <subject>`; any `Re:` or `[SS-n]` already on the stored subject is normalised so replies never stack tags. Customers replying through their mail client keep the tag in the subject, but threading is unchanged: `Message-ID` / `In-Reply-To` / `References` or the reply token only.
- **Backfill.** The migration numbers each Workspace's existing Conversations 1..n by `createdAt` (ties broken by id) and sets the counter past them.

## Stripe test/live key guard (issue #25, 2026-10-29)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the four price ids are
independent environment variables, and mixing Stripe modes (a live key with a
test price, a webhook secret from the other mode's endpoint) fails confusingly
or links test customers to production Workspaces. Working defaults the
maintainer can override:

- **What is detectable.** Only the secret key carries a mode marker
  (`sk_test_…`/`sk_live_…`, restricted `rk_…`); webhook secrets (`whsec_…`)
  and price ids (`price_…`) look identical in both modes, and Stripe never
  returns endpoint secrets, so the key↔endpoint pairing has no offline or API
  check. The guard therefore checks shapes statically (a key pasted into the
  webhook var, a publishable key, a lookup key as a price id) and asks the
  Stripe API, once per price and cached 5 minutes at first checkout use,
  whether the key's mode can see each configured price ("No such price" =
  mixed or deleted).
- **Failure mode.** Refuse, don't crash: billing routes answer `503
  billing_misconfigured`, the boot log states the problem once per problem
  set, and a webhook delivery whose signatures keep failing logs a throttled
  mixed-mode hint. Responses and logs name variables and modes ("test"/
  "live"), never key values.
- **Self-hosting (FR-HOST-01).** With no Stripe variable set the guard is
  inert — "unconfigured", not "misconfigured" — and billing routes still
  answer 404 in self-hosted mode first. The price check is network-failure
  tolerant: a Stripe blip never blocks checkout (fail open, same as today).

## Workspace API: Products created through the API (2026-10-20)

Raised by the token-authenticated `POST /api/products` ([FR-API-02](FRD.md)): a leaked `products:write` token could create about 43,000 Products a day at the 30 writes/minute limit.

| # | Question | **Resolution** |
| --- | --- | --- |
| API1 | Cap Products per Workspace? | **Resolved (maintainer, 2026-10-20, option 2):** an API create is refused with `409 product_limit_reached` once the Workspace already has 100 Products (`MAX_API_PRODUCTS_PER_WORKSPACE` in `src/lib/products.ts`; archived Products count, so archive-and-recreate cannot bypass it). It is an abuse guard for a leaked write token, not a plan limit: the dashboard and onboarding stay unlimited, so PRD "unlimited Products", FR-USE-03 and the M2 resolution (Pro: unlimited Products) remain true. API creates are serialised against each other by a Workspace row lock; dashboard and onboarding creates deliberately take no lock, so a dashboard create racing the last API create can leave the Workspace one over 100 (acceptable for an abuse guard). Self-hosted behaves the same and the cap is a constant, not configuration; making it configurable is a maintainer decision. Alternatives rejected: one cap in the shared create core (contradicts the unlimited promise), rate limit alone (leaves ~43k/day). |

## Agent-first Workspace API (2026-10-29)

Raised by [ADR-0005](adr/0005-agent-first-workspace-api.md) and [agent-api-plan.md](agent-api-plan.md) (requirements FR-API-04..17, planned). Rows marked **Resolved** are decided; phase 1 (the Conversations API) is being built on them. A remaining **Recommendation** is the position the plan assumes so work can be sliced, not a decision. Security of tenant isolation is the top requirement and is not an open question.

| # | Question | **Resolution / Recommendation** |
| --- | --- | --- |
| AA1 | May API tokens be created and revoked through the API? (changes FR-API-01) | **Resolved (maintainer direction, 2026-10-29):** yes, by a token holding `tokens:admin`, with scopes never exceeding the creator's, a required expiry, a self-revoke right and an audit entry for each change. The first token is still minted in the dashboard (or by hosted signup, FR-API-15). FR-API-01 is amended accordingly. |
| AA2 | The brief asked for one PR under 600 meaningful lines per phase. Phase 1 cannot fit; slice each phase into a stack? | **Resolved (maintainer direction, 2026-10-29):** yes, slices 1a-1f, 2a-2d, 3a-3c as in the plan (Phase 1 ships 1a-1e; 1f waits for AA4), each under 600 lines and each with its own isolation tests. The alternative (one large PR per phase) breaks the AGENTS.md size rule. |
| AA3 | Fate of `/api/products` once `/api/v1/products` exists? | **Resolved (maintainer direction, 2026-10-29):** keep it forever as a frozen alias with today's `{ "products": [...] }` shape, covered by the existing drift test; no deprecation. Alternatives: deprecate with a sunset date, or redirect (breaks writes and bearer headers). |
| AA4 | "Assign" needs the assignment/priority schema (V2, [design/assignment-priority.md](design/assignment-priority.md), AP-Q1..Q7). Build it inside this work? | **Recommendation:** no; `setAssignee` is the last slice (1f) and waits for the AP schema and its open questions. Phase 1 (slices 1a-1e) ships without it. |
| AA5 | How are token-authored replies attributed? `Message.agentUserId` is the only author field. | **Resolved (maintainer direction, 2026-10-29):** add nullable `Message.authorTokenId` (FK to `ApiToken`, `SetNull`); the inbox shows `<token name> (API)`. Alternatives: a synthetic "API" user per Workspace (pollutes membership and the agent cap) or no attribution (poor audit). |
| AA6 | Separate `conversations:reply` scope from `conversations:write`? | **Resolved (maintainer direction, 2026-10-29):** yes. A reply emails a customer under the Product's name, which is outward-facing; notes, tags and status are not. A human-approval mode for API replies is out of scope. |
| AA7 | What scopes do dashboard-created tokens get? | **Resolved (maintainer direction, 2026-10-29):** unchanged (`products:write` only, no silent widening) plus a scope picker with presets such as "Read-only inbox" and "Support agent"; existing tokens keep their scopes. **Interim default, maintainer instruction 2026-10-31 (overridable):** new dashboard tokens also carry `conversations:reply` and `conversations:write`, because agents must send replies through the API before the picker exists (17 customer conversations waited on a dashboard session) and building the picker is a larger slice. This deliberately departs from "no silent widening" until the picker lands. Existing tokens keep their scopes; a token minted earlier needs recreating to reply. Revert by restoring `API_TOKEN_SCOPES` in `src/lib/api-tokens.ts` to `["products:write"]`; the picker (a later slice) supersedes the constant. |
| AA8 | Token expiry policy for API-created tokens. | **Resolved (maintainer direction, 2026-10-29):** required `expiresAt` with no server default (omission is `400`), maximum 365 days; `null` is refused through the API (dashboard tokens keep their optional expiry). |
| AA9 | Can `tokens:admin` be selected in the dashboard UI? | **Resolved (maintainer direction, 2026-10-29):** yes, behind a warning ("this token can mint other tokens"), never in a preset. The API itself never grants `tokens:admin` (a leaked admin token could otherwise mint an unexpiring clone and revoke the original). |
| AA10 | Audit log retention and viewer. PRD lists audit logs as V2. | **Resolved (maintainer direction, 2026-10-29):** keep 90 days; expose through `GET /api/v1/audit-log` now (`audit:read`) and add a dashboard viewer in V2. Alternative: defer the whole audit log to V2, which loses the accountability the security requirement asks for. |
| AA11 | Default rate limits, given limits are in-process. | **Resolved (maintainer direction, 2026-10-29):** per token 120 reads, 30 writes and 20 replies per minute, 10 token-admin writes per minute; per IP 300 requests per minute. These are starting values to tune; per-process enforcement on multi-process self-hosted deployments stays documented, with no Redis. |
| AA12 | Webhook payload shape and secret storage. | **Recommendation:** full event data (message body, ids, tags) without attachment URLs, with a thin id-only option per subscription later. Secrets must be recoverable to sign, so store them encrypted with `WEBHOOK_SECRET_KEY` (required on hosted, so rotating the auth secret never breaks receivers) or, self-hosted default, a key derived from `BETTER_AUTH_SECRET`; document that rotating the latter then invalidates them. |
| AA13 | Webhook delivery needs the repo's first background loop (no scheduler exists). | **Needs Pete (long-lived infrastructure).** Recommendation: an in-process, bounded polling loop started from `instrumentation.ts` over a transactional outbox, consistent with ADR-0003; no Redis or new service. Alternative: an external cron calling a protected delivery endpoint. |
| AA14 | Webhooks to private-network targets on self-hosted installations. | **Recommendation:** public HTTPS only by default, plus an explicit host allow-list in the environment for self-hosters; no switch that disables the SSRF guard. |
| AA15 | Auto-disable threshold and delivery-log retention. | **Recommendation:** disable after 3 days of continuous failure and email Workspace admins; keep 14 days of delivery log; six retries with exponential backoff and jitter. |
| AA16 | API signup without a password: claim by email. | **Recommendation:** `POST /api/v1/signup` always answers the same way and creates a pending Workspace the human claims through the verification email (setting a password there); an address that already has an account never receives a claimable Workspace. Requires a spike for an ownerless pending Workspace. Hosted only. |
| AA17 | Challenge (CAPTCHA/proof-of-work) on API signup? | **Recommendation:** start with per-IP and per-address caps and a global kill switch; add a challenge hook only if abuse appears. The marketing site is separate, so a CAPTCHA widget would not apply to an API caller anyway. |
| AA18 | Limits and retention for unverified Workspaces. | **Recommendation:** at most 3 Products, no outbound replies, no token creation, deleted after 7 days if unclaimed. |
| AA19 | Migrate the existing dashboard code to the scoped data layer, and/or add Postgres row-level security as a second layer? | **Resolved (maintainer direction, 2026-10-29):** no to both for now. `/api/v1` is the new surface and gets the enforced layer; migrating dashboard code is a large risk-bearing diff for no new capability, and RLS needs per-request session variables that conflict with the PGlite test setup. Revisit after phase 1. |
| AA20 | Contact writes beyond delete (create, edit, merge) through the API. | **Resolved (maintainer direction, 2026-10-29):** `contacts:read` plus delete only in phase 1; no merge (cross-Product linking is internal, FR-INBOX-03). Add edit when a dashboard flow needs it. |
| AA21 | Team and invite management through the API (`team:write`). | **Recommendation:** include the scope in the registry but ship the operations last and keep it out of every preset and out of the unverified bootstrap token, because an invite sends email to a third party. |
| AA22 | What does `savedReplyId` mean on `createMessage`? The plan lists it but not its effect. | **Default taken in slice 1d (maintainer-overridable), recorded as AA22 under "Design decisions, Defaults".** Not decided by the maintainer. |
| AA23 | How does `createMessage` report delivery (the draft has `queued`, `sent`, `failed`, `not_applicable`)? | **Default taken in slice 1d (maintainer-overridable), recorded as AA23 under "Design decisions, Defaults".** Not decided by the maintainer. |

## Agent bootstrap credentials (issue #27, 2026-10-30)

Raised by [ADR-0006](adr/0006-agent-bootstrap-credentials.md) (proposed; design only, no code). It sits inside [ADR-0005](adr/0005-agent-first-workspace-api.md) and changes none of AA1..AA21: the API never grants `tokens:admin` (AA9), there is no CLI, hosted onboarding stays FR-API-15. Nothing below is decided: each row is a **Recommendation** with the main alternative, awaiting the maintainer. This is auth-adjacent, so no code is written past AB1..AB3.

| # | Question | **Recommendation** |
| --- | --- | --- |
| AB1 | Which mechanisms, and in what order? (A: operator setup secret for headless self-hosted first run; B: device-code approval by a signed-in Admin, existing Workspace.) | **Recommendation:** adopt both, A first because it is the only one that lets an agent that deployed the instance finish without a human, and B second. Alternative: B only (smaller, never creates a tenant, but still needs a human to register and onboard first), or neither (status quo, dashboard-minted first token). Either mechanism is conditional on HTTPS behind a TLS-terminating proxy that sets `x-forwarded-proto` with the listener reachable only through it (loopback excepted); the self-hosting guide's "no proxy" mode would not offer these flows. |
| AB2 | What proves the right to the first credential on self-hosted? | **Recommendation:** control of the deployment environment, shown by a `SETUP_TOKEN` env var of at least 32 characters. Alternative: a secret printed once to the log or a file on first boot (no config, but log shippers and shared volumes copy it). |
| AB3 | Who is the first Admin user when A creates the Workspace? | **Recommendation:** A takes the Admin address from operator configuration (`SETUP_ADMIN_EMAIL`), never from the request body, so the mailbox proof is the operator's and not one the agent can choose; it creates a Workspace with a pending Admin invite and emails a separate one-time `claimCode` (hashed at rest) to that address, never returning it to the agent; the human presents it at registration with the same email, so the proof the agent cannot supply is control of the mailbox; the claim is an atomic conditional update so exactly one claimer wins, and it does not depend on the setup secret, which is inert once the Workspace exists (AB6). This needs the ownerless-Workspace spike already required by FR-API-15 (`claimedAt` versus a placeholder user). Alternatives: print the `claimCode` once to the server log for an operator who has no outbound email (proof is log access, which AB2 weighs); return it to the agent (the agent can then register the first Admin, so the human never holds a login). Smaller alternative: the agent supplies email and password and the human rotates it, which hands a human login to an agent (ADR-0005 rejects that for sessions). |
| AB4 | Scopes of the A bootstrap token? | **Recommendation:** a setup preset only (`products:write`, `saved-replies:write`, `workspace:read`, `conversations:read`, final set after slice 1e), never `tokens:admin`, `conversations:reply`, `webhooks:*`, `team:write` or `billing:write`. Alternative: also `tokens:admin` so the agent can mint sub-tokens, which contradicts AA9. |
| AB5 | When `SETUP_TOKEN` is set, does first-account `/register` also require it? | **Recommendation:** yes, until the Workspace exists; after that `/register` accepts only a valid `claimCode` (AB3) until it is claimed, then closes as today. This closes the first-come window on a public port. Alternative: leave `/register` unchanged (status quo behaviour; a stranger who registers first still wins). |
| AB6 | Lifetimes: setup-secret window and bootstrap-token expiry. | **Recommendation:** the secret works until the first Workspace exists, then is inert (the `claimCode` of AB3 is the only credential still live, one-time, with its own 30-day expiry independent of the 7-day token, so a human on holiday can still claim; an expired, unclaimed `claimCode` leaves a Workspace with no Admin; recovery is the operator recreating the database while it is still empty, or manual database intervention once the agent has put data in it (accepted cost, to be revisited if it happens); a lost bootstrap response is recovered by the human claiming with the emailed `claimCode` and minting a fresh token (the operator recreates the empty database only when no outbound email is configured), with no re-issue window; the bootstrap token expires in 7 days (required, within AA8's 365-day cap). Alternatives: a bounded re-issue window (for example 15 minutes) authenticated by the same secret; secret expires 24 hours after boot; token 30 or 90 days. |
| AB7 | Device-code (B) parameters and approver safeguards. | **Recommendation:** 10 minute code life, 5 second interval, 8 character user code from a 20-letter alphabet with attempt limits per code and per IP, approval page shows label, requester IP and scopes, approver may only narrow scopes and must set an expiry, `tokens:admin` never grantable, pending rows capped and purged. Alternative: let the approver grant `tokens:admin` behind the AA9 warning. |
| AB8 | Is B enabled on the hosted tier? | **Recommendation:** off until the maintainer enables it; A is never available when `HOSTED_MODE=1`, decided by the mode alone. Alternative: B on hosted behind an env flag, since a human Admin must approve and it cannot create a tenant. |
| AB9 | Rate limits and audit. | **Recommendation:** failed A attempts use the existing 20/min/IP failed-auth bucket plus a dedicated 5/min/IP and 20/hour global bucket; B `authorize` is 10/min/IP with a global pending cap; every success, denial and throttled attempt is an audit row (slice 1b) bounded per the plan. Depends on the audit log landing first. |

## Marketing site (2026-09-25)

Raised by `docs/design/marketing-site.md` (now in the private `supportseal-marketing` repository) (launch
readiness, outside V1). Details and context are in that doc's "Open
questions".

| # | Question | **Default** (if any) |
| --- | --- | --- |
| M1 | Serve marketing only in hosted mode, or behind its own flag? | **Default:** hosted mode only; self-hosted `/` unchanged |
| M2 | Hosted tier shape: `usage.ts` gives Pro unlimited Conversations and no agent limits, unlike volume-based paid tiers, and the original plan of one agent on Free | **Resolved (maintainer, 2026-09-26, issue [#15](https://github.com/Supportseal/SupportSeal-app/issues/15)):** Free $0 — 100 new Conversations/month, 1 agent; Pro $39/month — 1,000 new Conversations/month, unlimited agents and Products; never advertised as unlimited Conversations. **Repriced (maintainer, 2026-10-28):** Pro $19/month or $190/year (same limits, replaces the $39 price; no subscribers were on it); new Business plan $99/month or $990/year with unlimited Conversations, agents and Products. Pro to Business switching is not offered at checkout (a subscribed Workspace gets 409); it is deferred to the Stripe customer portal once that is configured with both products. A subscription on a price that matches no configured id or lookup key is treated as Pro, so an unrecognised price never grants unlimited Conversations. Recorded in `src/config/pricing.ts` (single source), FR-USE-02, marketing copy and SF-12 |
| M9 | What happens when a Free Workspace's grace period ends? (Until now grace was a 30-day reminder with no consequence.) | **Resolved (maintainer, 2026-10-28):** Free grace is 7 days from the crossing (`FREE_GRACE_DAYS`, fixed; `USAGE_GRACE_DAYS` now only lengthens the paid plans' 30-day window), with one reminder email per grace day to admins (days 1–6, then a "paused" notice on day 7; `src/lib/grace-reminders.ts`). After that the widget and contact form refuse new messages (`402 service_paused`) and agent replies are refused until the Workspace upgrades (the pause is stored on the Workspace, `freePlanPausedAt`, so the monthly allowance reset does not lift it; maintainer: "until paid"); inbound email is still stored, notes/tags/status still work (`src/lib/service-pause.ts`). Workspaces already over the allowance when this shipped count their 7 days from 2026-10-29 (`FREE_GRACE_EFFECTIVE_FROM`), and a Workspace that downgrades to Free while over the allowance counts them from the downgrade (`freePlanSince`, stamped by billing sync). Paid plans keep the soft window and are never paused. Self-hosted is never paused. Recorded in FR-USE-02 |
| M3 | Privacy/Terms pages before public hosted sign-up | None: launch-order decision. Drafts live on the marketing site (`/legal/*` in [supportseal-marketing](https://github.com/supportseal-marketing), [#14](https://github.com/Supportseal/SupportSeal-app/issues/14)), marked draft and noindex, and are linked from nothing public until the maintainer marks them operative there after legal review |
| M4 | Changelog: GitHub Releases or a site page | **Default:** GitHub Releases, link hidden until the first release |
| M5 | Run the real widget on the marketing site (dogfooding) | None |
| M6 | Demo seed is required for all screenshots | None: scheduling |
| M7 | Commit the screenshot-capture script? | **Default:** not committed; procedure documented in the design doc |
| M8 | Keep a "Not yet" section on `/features` | **Default:** keep |

## Diagnostics (V2 design, 2026-09-29)

Raised by [design/diagnostics.md](design/diagnostics.md) (V2, not V1).
Details and the full list of defaults are in that doc's "Decisions and
defaults" and "Open questions".

| # | Question | **Default** (if any) |
| --- | --- | --- |
| Q1 | Notice or consent: is a customer-controlled switch plus a widget notice enough, or is a "wait for consent" mode and/or visitor opt-out needed (legal, GDPR/UK GDPR review)? | **Default:** notice line plus the developer pause hook (`diagnostics(false)` pauses and clears the buffer; `diagnostics(true)` resumes); wording from legal review |
| Q2 | Retention period for diagnostic snapshots | **Default:** 30 days, fixed until configurable retention lands |
| Q3 | Capture "warnings" via a narrow `console.warn`/`console.error` wrapper, or drop warnings from the slice? | **Default:** narrow wrapper; primitives as text, an `Error` as `name: message`, anything else as `[object]` |
| Q4 | Add a scheduled purge job (new infrastructure) or accept hidden-until-purged expired rows? | **Default:** read-time expiry filter plus bounded purge on ingest; no new job |

## Product branding (V2 design, 2026-10-01)

Raised by [design/branding.md](design/branding.md#open-questions). This is a
design for a later build, not a change to V1 or a record of the maintainer's approval.

| # | Question | Default or unresolved boundary |
| --- | --- | --- |
| BQ1 | Logo formats, budgets and no-logo fallback | **Default:** static PNG/JPEG/WebP, 2 MiB input, bounded dimensions, sanitised WebP ≤100 KiB; contained square mark with Product initial/colour fallback |
| BQ2 | Hosted/self-hosted storage and public vs signed delivery | **Default:** existing local persistent storage and public app route, five-minute cache; CDN/provider unselected, private delivery requires revised design |
| BQ3 | Launcher corners | **Default:** bottom-right initially, bottom-left optional; no top corners/free offsets |
| BQ4 | Greeting length, placement and i18n | **Default:** one plain-text value, 240 Unicode code points / three lines / 1,024 UTF-8 bytes, shown before messages in Live/Away; no translation; blank restores V1 behaviour |
| BQ5 | Image decoder dependency and deployment support | **Unresolved:** later build must propose a maintained decoder and obtain the normal dependency checkpoint before adding it |
| BQ6 | Crash recovery and failed asset deletion | **Default:** immediate compensating cleanup and observable failures; **unresolved:** concrete recovery procedure/retry ownership before shipping, with explicit approval if new infrastructure is needed |

## Assignment and priority (V2 design, 2026-10-01)

Proposed build contract: [design/assignment-priority.md](design/assignment-priority.md).
Its “Defaults and open questions” section owns AP-Q1–AP-Q7 and the associated
acceptance criteria. These are working defaults the maintainer can override, not
resolved decisions or additions to V1. None blocks the scoped design.

| ID | Question | **Default** |
| --- | --- | --- |
| AP-Q1 | Auto-assign on first agent reply? | No; explicit assignment only |
| AP-Q2 | Notify an assignee whose dashboard is inactive? | No; active-dashboard notices, Mine and private history only |
| AP-Q3 | Require an explicit priority choice? | No; required stored value defaults to Normal |
| AP-Q4 | Keep assignee and priority on reopen? | Yes, while the assignee remains a member |
| AP-Q5 | Allow Agents to reassign anyone's work/change priority? | Yes; same triage rights as Admins |
| AP-Q6 | Include bulk assignment/priority? | Defer; header controls only in the first slice |
| AP-Q7 | Default to Priority first sorting? | No; retain Latest activity, offer Priority first |

## Accessibility (V2 design, 2026-10-01)

Raised by [design/accessibility.md](design/accessibility.md). Its `AX-*`
criteria define the later build; **Defaults** are working choices, not
recorded approvals or a claim of conformance. The build can proceed with
WCAG 2.2 AA as its target, standard Tab navigation, opt-in inbox shortcuts
and the documented manual test matrix. Agent avatars, presence and typing
indicators remain outside this slice.

| # | Question | Working position |
| --- | --- | --- |
| AQ1 | Require an independent audit or published conformance report before a public AA claim? | Undecided. No external audit commissioned or public claim authorised; internal implementation and verification can proceed. |
| AQ2 | Additional customer-required assistive technology/browser/email-client coverage? | **Default:** the design's NVDA/Firefox, VoiceOver/Safari, TalkBack/Chrome and email-client matrix; record gaps, do not promise untested contractual coverage. |
| AQ3 | Publish an accessibility statement and dedicated feedback contact? | **Default:** existing support/contact routes; the maintainer decides ownership/contact and any public commitment. No invented address or SLA. |

## Unanswered-request escalation (2026-10-07)

Raised by [design/escalation.md](design/escalation.md) (FR-INBOX-05).
Defaults the maintainer can override.

| # | Question | **Default** |
| --- | --- | --- |
| E1 | Default wait time | **Default:** 20 minutes, one value for chat and email, configurable 5–1440 per Product. Long enough that an agent mid-conversation or finishing a reply does not trigger a false alarm, short enough that a visitor has not given up; email customers tolerate more delay but one shared setting avoids two knobs |
| E2 | Who is "the product owner"? A Product has no owner field; Workspaces have Admins and Agents (FR-ACC-01) | **Default:** all Workspace Admins, matching the allowance emails (FR-USE-02). A per-Product recipient override is deferred |
| E3 | On by default? | **Default:** on for every Product, including existing ones, as soon as an outbound mail provider exists; disable per Product |
| E4 | Scheduling without a worker | **Default:** lazy sweep + in-process timer + optional `CRON_SECRET` endpoint, all backed by an atomic DB claim; no new infrastructure |

## Product analytics (V2 design, 2026-10-01)

Raised by [design/analytics.md](design/analytics.md), the PRD's later product
analytics slice, separate from hosted marketing Umami. Defaults are working
choices, not the maintainer's answers; full definitions and acceptance criteria live in
the design. No V1 usage or billing behaviour changes.

| # | Question | **Default** (if any) |
| --- | --- | --- |
| A1 | Staff activity visibility and disclosure | **Default:** Admins see team activity; Agents see their own activity plus operational Workspace/Product summaries. The maintainer owns the policy and release disclosure review. |
| A2 | Reporting horizon | **Default:** 90 UTC calendar dates, with a 30-day initial view, in both hosting modes; annual history needs further retention/performance design. |
| A3 | Guaranteed physical purge of expired analytics data | **Default:** read-time expiry plus bounded opportunistic cleanup; inactive installations may retain hidden rows. A guaranteed deadline requires an infrastructure decision. |
| A4 | Hosted billing audit after source deletion | No new policy decided. Analytics preserves existing usage behaviour and reconciles against current source records; any durable post-deletion billing ledger is separate usage work. |

## Presence (V2 design, 2026-10-01)

Raised by [design/presence.md](design/presence.md), the deferred presence
half of richer branding and presence; independent of branding PR #37.
See its [Open questions](design/presence.md#open-questions) for trade-offs.
These are working defaults, not resolved policy approvals.

| # | Question | **Default** (if any) |
| --- | --- | --- |
| PQ1 | Internal staff identity only, or visitor-facing names/photos per Product? | **Default:** team-only membership photos; retain D4 “{Product} Support” and generic public typing. Public identity needs separate consent/alias/visibility rules. |
| PQ2 | Informational activity, or personal availability/automatic Live/Away? | **Default:** automatic team-only activity; manual Workspace-wide Live/Away stays authoritative. |
| PQ3 | Visitor typing on by default, Product opt-in or visitor opt-out? | **Default:** on for established chat Conversations; no pre-message/away-form collection or draft contents. Review disclosure and any required consent/opt-out before shipping. |
| PQ4 | Avatar decoder and recovery for interrupted file/database operations? | **Unresolved:** a concrete dependency and cleanup/retry ownership proposal is required before uploads are built; coordinate with branding where available. No new service/job approved. |
| PQ5 | Opportunistic deletion or a strict physical presence-data purge deadline? | **Default:** hide expired leases immediately, delete opportunistically in bounded batches; inactive installations/backups may retain expired rows. Strict deadlines need an approved operating procedure. |

## Widget visitor sessions (issue #61, 2026-10-02)

Raised by the sticky-session fix (issue #61): visitor identity follows the
visitor token; a session is bound to the Product and the exact embedding
origin (scheme + host + port), `identify()` only enriches the current
session, and clearing client cookies/storage yields a fresh anonymous
visitor ([design/chat-widget.md](design/chat-widget.md) "Resume").

| # | Question | Working position |
| --- | --- | --- |
| WQ1 | "Start a new conversation" affordance for returning visitors? | **Undecided product decision** (issue #61 work item 4). V1 keeps the design's rule: a visitor message reopens their existing (even Closed) Conversation and there is deliberately no such button; revisit only if visitors ask for it. |
| WQ2 | Cross-device history for identified users? | **Default:** no. History returns only with a valid visitor token or an explicit sign-in flow (none exists in V1); `identify()` must not resurrect a session on a cleared or different client. |

## Widget panel CSP and the Cloudflare beacon (issue #71, 2026-10-07)

Cloudflare zones with Web Analytics inject the RUM beacon
(`static.cloudflareinsights.com/beacon.min.js`, reporting to
`cloudflareinsights.com/cdn-cgi/rum`) into every HTML response — the widget
panel included. The panel's strict CSP blocked it there, silently dropping
the host's analytics for the widget context (observed on a widget host with
Web Analytics enabled).

| # | Question | Working position |
| --- | --- | --- |
| BQ1 | Allow the beacon in the panel CSP or leave strict? | **Default:** allow, but only the two Cloudflare-operated origins (`script-src … https://static.cloudflareinsights.com`, `connect-src … https://cloudflareinsights.com`); every other directive stays as narrow as before. Trade-off: host analytics integrity vs a slightly wider script surface in the panel. Origin granularity (not a pinned path) because Cloudflare serves the beacon under versioned paths. Pinned by `src/lib/__tests__/widget-panel-csp.test.ts`; a wider allow must be a conscious decision recorded here. |

## Installation panel (issue #192, 2026-10-21)

A per-Product "Installation" panel (Settings → Products → Widget tab) shows
where the widget config was last loaded from and which hostnames were
refused, with an **Allow** button. Approved by the maintainer on 2026-10-19
with the defaults below; the table is `widget_host_signals`, written from the
public `GET /api/widget/config` after the response.

| # | Question | Working position |
| --- | --- | --- |
| IQ1 | What is stored? | **Resolved (maintainer, 2026-10-19, [#16](https://github.com/Supportseal/SupportSeal-app/issues/16)):** Product, hostname, outcome (`LOADED`/`REJECTED`) and last-seen time. No visitor data (no IP, user agent, cookie, referrer path). Requests admitted only by the signed test token (hosted test page) record nothing. |
| IQ2 | Cap on distinct hostnames | **Default:** 50 per Product and outcome. A full `LOADED` list keeps its rows (spoofed subdomains of a wildcard entry cannot evict a real host); a full `REJECTED` list replaces its stalest row. Override: `HOST_SIGNAL_CAP` in `src/lib/install-signals.ts`. |
| IQ3 | Rejected hostnames | **Default:** stored for real, unarchived keys only; rate-limited to 10 new hostnames per Product per minute per instance; TTL 30 days; shown with Allow (admin-only, through `patchProduct`, so the apex/`www.` sibling option applies). |
| IQ4 | Retention of loaded hostnames | **Default (not in the issue):** 90 days without a load, so junk from a wildcard entry ages out while a low-traffic site stays visible for a quarter. Override: `LOADED_TTL_MS`. Pruning is lazy, inside the write path; there is no scheduler. |
| IQ5 | Write throttle | **Resolved (maintainer, 2026-10-19, #192):** at most one write per (Product, hostname, outcome) per hour — in memory per instance in front of the DB, and again in the DB (`lastSeenAt` must be older than an hour to update). |
| IQ6 | Hosted vs self-hosted | **Resolved (maintainer, 2026-10-19, #192):** both; in-database only, so FR-HOST-01 (no external telemetry, no Stripe or hosted-API dependency) holds. |
| IQ7 | Onboarding "Install the widget" | **Default:** done when a `LOADED` signal exists for any active Product in the Workspace **or** the first Conversation exists (the design's "config request arrives from an allowed origin, or item 2 completes"). Previously only the conversation counted. |

Known limits (accepted): the widget key is public and the origin gate trusts the
declared `host` when no Referer is sent, so anyone with the key can plant a
`LOADED` row for an *allowlisted* hostname (and so tick the onboarding item) or
churn the `REJECTED` list with spoofed hostnames, which evicts older refused rows.
Writes and storage stay bounded (10 new hosts/min/Product/instance, 50 rows), only
an admin click turns a refused hostname into an allowlist entry, and the signal is
advisory, never a security boundary. Throttle memory is per instance; the DB-side
hourly check and the cap hold across instances.

## Widget visual refresh (2026-10-08)

The widget UI/UX overhaul (approved task) asked for light and dark variants,
which supersedes the design doc's earlier "light-only in V1" line.

| # | Question | Working position |
| --- | --- | --- |
| WQ1 | Which signal picks the widget's dark theme? | **Default:** the visitor's `prefers-color-scheme`, inside the panel iframe. It can disagree with a host site that forces light; a per-Product "always light/dark/auto" setting is the override if that matters in practice. |
| WQ2 | Text colour on the Product colour | **Default:** whichever of black or white has the higher WCAG contrast ratio (previously a 0.35 luminance threshold, which put white text on mid-tone colours such as `#ca8a04` at 2.94:1). |

## 1. V1 scope: marketing site, analytics, legal drafts, demo data

An early planning document attached the marketing site, Umami analytics,
draft legal documents and a seeded demo environment to V1/launch, while the
PRD ([PRD.md](PRD.md) "V1 boundary") scoped V1 without them.

**Resolved (maintainer, 2026-09-25):** V1 scope is the PRD's V1 boundary as
written. The marketing site, Umami analytics, draft legal documents and
demo data are out of V1. Recorded in [PRD.md](PRD.md) "V1 boundary".

## 2. Billable Conversation lifecycle

**Resolved (maintainer, 2026-09-25, with design answer D3):** option a) is chosen:
a Conversation counts once ever, in the billing period in which it was
first opened. A reply to a Closed Conversation reopens it rather than
creating a new one, and reopening or continuing it in a later period never
counts again. Recorded in FR-USE-01 ([FRD.md](FRD.md)) and
[architecture.md](architecture.md). The maintainer stated this in the reopen answer
("consistent with a billable Conversation being counted once ever"), not as
a separate answer to this question; it can be re-opened if that reading is
wrong.

## 3. Multi-Workspace self-hosting

The early planning document said "one deployment effectively represents one
Workspace"; ADR-0001 previously said "normally has one Workspace"; FR-HOST-01 said "can
represent one Workspace". The docs now uniformly say a self-hosted deployment
represents one Workspace in V1, but none states whether additional Workspaces
are blocked, merely untested, or supported.

**Resolved (maintainer, 2026-09-25):** enforced single-Workspace. A self-hosted
installation blocks creating additional Workspaces; the schema stays
multi-Workspace capable. Recorded in FR-HOST-01
([FRD.md](FRD.md)), [architecture.md](architecture.md) and
[ADR-0001](adr/0001-shared-codebase-and-tenancy.md).

## 4. UI kit licensing

**Resolved (maintainer, 2026-09-25):** the UI kit has no licensing restrictions.
Third-party proprietary theme source, assets and components are never copied
into this AGPL repository. How the kit is used is in [design/](design/).

## 5. AGPLv3 LICENSE file

**Resolved (maintainer, 2026-09-25):** add the AGPLv3 LICENSE now. The standard GNU
AGPLv3 text (verbatim from the FSF) is at the repository root (`LICENSE`);
README.md's licence section links it.

## 6. Product name

**Resolved (maintainer, 2026-09-25):** SupportSeal is the real product name. The
brand is mint green; the palette, tokens and logo direction are in
[design/brand.md](design/brand.md). The name stays centrally configured
(`src/config/site.ts` → `brand.name`) rather than
scattered through code, tables or templates. README.md and AGENTS.md now
use the name accordingly.

**Update (maintainer, 2026-09-29):** after a rename shortlist (challengers lost
on trademark or domain availability), the name **stays SupportSeal** and
the official domain is **supportseal.app** (free at the 2026-09-29 RDAP
check; the maintainer registers it). `supportseal.com` is held by a domain investor
(GoDaddy, sale-listed, created 2025-08) and is not pursued for now. The
host layout is decided the same day: **single origin** — marketing,
dashboard, widget and API all on `https://supportseal.app` (runbook: the
internal hosted-deployment notes; `app.supportseal.app` stays
reserved for a future split). Issue
[#5](https://github.com/Supportseal/SupportSeal-app/issues/5) resolves via the
`NEXT_PUBLIC_APP_URL` deployment value — `trustedOrigins` is dynamic.

**Update (maintainer, 2026-10-06):** the single origin is split before the app
repository is open-sourced. The marketing site moves to its own private
repository (`supportseal-marketing`) and serves `supportseal.app` +
`www`; the product (dashboard, widget, API, webhooks) moves to
`https://dashboard.supportseal.app`. Mail stays on the apex
(`INBOUND_EMAIL_DOMAIN=supportseal.app`). The apex keeps routing
`/widget.js`, `/widget`, `/widget-diagnostics.js` and `/api/*` to the app
for installed widget snippets and existing webhooks; former product pages
on the apex 308-redirect to the dashboard (runbook: the internal
hosted-deployment notes).

## 7. Tracking of deferred specs

**Resolved (maintainer, 2026-09-25):** deferred specs are tracked as GitHub issues
on [Supportseal/SupportSeal-app](https://github.com/Supportseal/SupportSeal-app); each
issue links back to its owning document:

| Spec | Owning document | Issue |
| --- | --- | --- |
| Auth library | [ADR-0002](adr/0002-independent-authentication.md) | [#4](https://github.com/Supportseal/SupportSeal-app/issues/4) |
| Realtime delivery spike | [ADR-0003](adr/0003-realtime-delivery.md) | [#2](https://github.com/Supportseal/SupportSeal-app/issues/2) |
| Email provider | [ADR-0004](adr/0004-email-boundary.md) | internal decision record |
| Deployment host | [architecture.md](architecture.md) | internal decision record |
| Test framework | pinned in `package.json` / CI | [#13](https://github.com/Supportseal/SupportSeal-app/issues/13) |
| Free-tier limits | pricing configuration (centralised in the application) — decided in [#15](https://github.com/Supportseal/SupportSeal-app/issues/15), recorded in `src/config/pricing.ts` | [#12](https://github.com/Supportseal/SupportSeal-app/issues/12) | |

## 8. First email provider

ADR-0004 requires comparing hosted provider candidates for inbound
parsing, signatures, attachment limits, deliverability, local testing and
cost before selecting the first provider. Tracked as
internal decision record.

**Resolved (maintainer, 2026-10-06):** SendGrid. The first provider, chosen on
2026-09-26, was replaced on 2026-10-06; the provider comparison and the
migration record are in internal decision record.
The adapter boundary stays provider-neutral per
[ADR-0004](adr/0004-email-boundary.md), and the SendGrid adapter lives in
`src/lib/email/providers/sendgrid.ts`. Self-hosted deployments remain
provider-independent ([self-hosting.md](self-hosting.md)). The hosted
subprocessor row for #14 is "SendGrid (Twilio)".

## V2 sender-domain design

The [verified custom sending domains design](design/sender-domains.md) proposes
V2 behaviour; it does not change V1 or resolve the maintainer's product decisions.
Working defaults SD1–SD6 cover one active sender per Product, `support` as the
local-part, no composer From overrides, 30-day failed-setup retention, explicit
managed fallback, and required DNS checks with a 24-hour freshness limit.
See its [defaults and open questions](design/sender-domains.md#defaults-and-open-questions)
for trade-offs and override points.

**Open before hosted rollout:** maintainer/operator must confirm the SendGrid account
and plan suitability for multi-tenant customer-domain sending and choose resource
isolation based on actual provider constraints. No account limit, reputation
isolation guarantee or pricing/plan restriction is decided by this design.
