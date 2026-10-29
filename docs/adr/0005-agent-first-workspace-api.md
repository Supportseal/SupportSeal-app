# ADR 0005 — Agent-first Workspace API

Status: Proposed (maintainer direction 2026-10-29; the phase PRs implement it, and each open question in [open-questions.md](../open-questions.md#agent-first-workspace-api-2026-10-29) is a maintainer decision)
Date: 2026-10-29

## Decision

Everything a human can do in the SupportSeal dashboard, an AI agent (or any
script) can do through a token-authenticated JSON API, including onboarding.
No CLI. A remote MCP server comes later as a thin wrapper over the same API
and scopes; it gets no capability the API lacks.

1. **One API, one tenancy rule.** The Workspace API grows from Products
   (FR-API-01..03) to Conversations, Messages, Contacts, Saved replies, Tags,
   Webhooks and Tokens, and finally to signup. It reuses the existing token
   auth, error envelope, rate limits and drift-tested OpenAPI contract. There
   is no second auth scheme and no second error shape.
2. **Tenant comes from the token and nothing else.** A request's Workspace is
   the `workspaceId` of its token row. It is never read from the body, path,
   query or a header. Every data access goes through a Workspace-scoped data
   layer (the *choke point*, below), so a route cannot forget the scope.
3. **FR-API-01 changes.** Tokens become creatable and revocable through the
   API by a token holding the `tokens:admin` scope. Until now tokens were
   dashboard-only. The dashboard stays the way to mint the first token on an
   existing Workspace; the API-signup flow (phase 3) mints a bootstrap token.
   The reasoning and the safeguards are under "Tokens through the API".
4. **Granular, least-privilege scopes** replace the single `products:write`
   scope. The existing scope keeps working and keeps its meaning.
5. **`/api/v1` is canonical** for the new surface. `/api/products` stays as a
   permanent alias that shares the same handlers, so published quickstarts and
   existing tokens keep working.
6. **Phased delivery**, each phase a stack of slice PRs (each under 600
   meaningful lines), each phase gated by a cross-tenant test suite over every new endpoint.
   See [agent-api-plan.md](../agent-api-plan.md).

## Why

The product's buyer builds several products and increasingly delegates setup
and daily support triage to coding and support agents. An agent can only use a
dashboard through brittle browser automation, which is slow, unauditable and
unsafe to hand a session cookie. A first-class API with scoped, revocable
tokens is both easier for agents and safer for the human than sharing a login.

The API widens the attack surface in exactly the place customers care about
most: nobody may ever read or change another tenant's conversations,
messages, contacts, attachments, products, webhooks or tokens (FR-SEC-01,
ADR-0001). Most of the work in this ADR is therefore about making
cross-tenant access structurally impossible rather than something each route
must remember.

## Tenant isolation design

Applies to every endpoint added by every phase.

### Resolution

- The caller is resolved by `authorizeAdminApi`-style bearer auth. The token
  row supplies `workspaceId`, `scopes`, `expiresAt` and `revokedAt`.
- A request carrying `Authorization` is judged on the token alone (existing
  rule). Mutating requests accept tokens only, never a session cookie
  (existing rule; extended to all new writes).
- Nothing in the body, path, query, cookie or any header selects a Workspace.
  A route handler receives a `WorkspaceScope` object, not a raw id, and has no
  way to ask for another one.

### The choke point

A new module (proposed name `src/lib/workspace-scope.ts`) is the only way API
code reaches tenant tables.

- `scopedDb(workspaceId)` returns a Prisma client built with `$extends`
  (query extension on every tenant model). For `findMany`, `findFirst`,
  `count`, `aggregate`, `groupBy`, `updateMany` and `deleteMany` it ANDs
  `workspaceId` into `where`; for `create` it forces `workspaceId`; for
  `findUnique`, `update`, `delete` and `upsert` (which accept unique
  selectors) it is rewritten to the scoped `findFirst`/`updateMany` form, or
  refused, so an id alone can never select a row.
- Models without a `workspaceId` column (Message, ConversationTag,
  SavedReplyProduct, MessageReadReceipt, ChatVisitor, and ProductDomain,
  ProductMailDomain, WidgetHostSignal via Product) are
  reached only through their Conversation/SavedReply/Product parent with the
  scope applied (DiagnosticSnapshot has its own `workspaceId`) (`where: { conversation: { workspaceId } }`). The extension refuses
  a direct query on such a model that lacks the relation filter.
- Raw SQL (`$queryRaw`, `$executeRaw`) is forbidden in `src/app/api/v1/**`;
  the extension cannot see it.
- A lint rule (ESLint `no-restricted-imports` plus a custom
  `no-restricted-syntax` selector) forbids importing `@/lib/prisma` or the
  generated client from any file under `src/app/api/v1/**` and
  `src/lib/api/**`; they may import only `scopedDb`. A static test also
  parses these files and fails on `prisma.` or `$queryRaw`. See "Required
  tests".
- Defence in depth, not a substitute: every service function still takes the
  scope as its first argument, and the existing dashboard code is not
  migrated by this work (it keeps its own checks and tests; migrating it is a
  possible follow-up).

### Indistinguishable failures

- An id that belongs to another Workspace answers exactly like an unknown id:
  same status (`404 not_found`), same body, same headers, and within a
  tolerance the same timing (single indexed lookup, no extra work on the
  "exists elsewhere" path because the scoped query never sees the row).
- The same applies to ids nested in a body (for example `productId` when
  creating something, `savedReplyId` when replying): validation failure for a
  foreign id is `404 not_found` with the same message as an unknown id, never
  `409`/`422` that reveals existence.
- Token failures stay indistinguishable (existing rule). Scope failures are
  `403 insufficient_scope` and reveal only the required scope name of the
  endpoint, never data.

### No enumeration through side channels

- **Ids.** Ids stay random UUIDs. Human reference numbers (`SS-123`) are
  per-Workspace and are accepted only as a filter inside the scope, never as a
  lookup key that could confirm existence across Workspaces.
- **Cursors** are opaque, signed and bound to the Workspace and the query
  shape. A cursor is `base64url(payload).HMAC-SHA256(serverSecret,
  workspaceId | route | resolved path ids | filterHash | payload)`. A cursor from another
  Workspace, another route, other filters, or a tampered cursor fails with the
  same `400 invalid_cursor` regardless of cause. Payload holds only sort-key
  values of rows already visible to the caller.
- **Errors** never echo another tenant's data, and never say "exists but you
  may not". Messages are generic; field-level `details` name only fields of the
  caller's own request.
- **Counts and totals** are not returned by list endpoints (no `total`), so
  they cannot be used to probe sizes. Lists are scoped before pagination.
- **Attachment URLs.** Attachments are returned as API-relative paths
  (`/api/v1/attachments/{id}/content`) that require the same bearer token and
  are scoped like every other resource; they are never public, never embed a
  storage key, and never carry a bearer-less signed URL in V1 of this API. A
  token reads only its own Workspace's attachments (`attachments:read`).
  Webhook payloads reference attachments by id and metadata only, not by a
  fetchable URL, so a leaked payload does not grant file access.
- **Webhook payloads** are assembled from the same scoped reads as the API,
  inside the delivery worker, keyed by the subscription's `workspaceId`; an
  event row carries `workspaceId` and a subscription only receives events with
  its own `workspaceId`. A payload never contains another Workspace's ids.
- **Timing.** Auth lookups are by SHA-256 hash (existing). Comparisons of
  secrets use `timingSafeEqual`. Not-found and forbidden-in-another-Workspace
  take the same code path.

### Limits and accountability

- **Scopes**: least privilege, listed in [agent-api-plan.md](../agent-api-plan.md#scopes).
  A token created through the API can never hold a scope its creator lacks
  (no privilege escalation), and `tokens:admin` is never granted implicitly
  and never to an API-created token: only the dashboard grants it (AA9), so a
  leaked admin token cannot mint an unexpiring clone and revoke the original.
- **Expiry**: new API-created tokens require an explicit expiry (maximum
  1 year; no server default, omission is a 400); `expiresAt: null` is refused through the API. Dashboard
  tokens keep today's optional expiry.
- **Revocation** is immediate and by id, and a token can revoke itself.
- **Rate limits**: per token (reads and writes separately) and per IP for
  failed auth, extending `widget-rate-limit`-style buckets already used for
  the Product API. Limits are in-process (documented; unchanged from
  FR-API-02).
- **Body caps**: 64 KiB for JSON (existing); webhook target URL and header
  sizes capped; attachment upload (if added) uses the FR-FILE-01 limits.
- **Audit log**: every token-authenticated write (and every token
  creation/revocation) writes an append-only `ApiAuditLog` row: Workspace,
  token id, operation id, resource type and id, request id, IP, outcome,
  timestamp. No request bodies, no secrets. Readable by `audit:read` and in
  the dashboard. Refused scope and cross-Workspace attempts are logged too,
  bounded per token per hour so a flood of foreign ids cannot grow the table.
  Retention is an open question (AA10).

### Tokens through the API (the FR-API-01 change)

Why allow it at all: an agent that provisions integrations needs to hand a
narrowly scoped token to a sub-agent or CI job without a human round trip.
Why it is safe enough:

- Only a token holding `tokens:admin` can create, list or revoke tokens. The
  dashboard mints tokens with the existing `products:write` scope only, so
  nothing existing gains the right.
- A created token's scopes must be a subset of its creator's scopes; the
  secret is shown once in the creation response and never again; listing
  shows the same fields as the dashboard (last four, times, expiry, scopes,
  revoked), never the hash.
- A token cannot be created for another Workspace; the Workspace is the
  creator's, from the token.
- Creation and revocation are audit-logged and rate-limited more tightly than
  other writes.
- Open question (recommendation given, AA9): whether `tokens:admin` can be
  requested in the dashboard UI behind a warning. Either way the API never
  grants it.

## Idempotency

Writes that create or send accept an `Idempotency-Key` header. A key is scoped
to (Workspace, token, method, resolved path with its ids) and remembered for
24 hours with a hash of the request body, so the same key against another
Conversation never replays a stored response. A replay with the same key and body returns the original
response; the same key with a different body is `409 idempotency_conflict`.
Keys never cross Workspaces. This also makes agent retries safe for replies,
which are the one write with an outbound side effect (email delivery).

## Webhooks (phase 2)

Outbound webhooks (events listed in the plan) are signed, replay-protected and
SSRF-hardened. Decisions:

- Signature header `SupportSeal-Signature: t=<unix>,v1=<hex HMAC-SHA256>` over
  `<t>.<raw body>` with a per-subscription secret shown once; receivers reject
  timestamps older than 5 minutes. Secret rotation keeps the old secret valid
  for a bounded overlap (both signatures sent).
- Target URLs must be `https`; plain `http` is never allowed. Self-hosters who
  must reach a private receiver use an explicit host allow-list in the
  environment (open question AA14), not a switch that disables the guard. Before every delivery the hostname is resolved and every address
  is checked against loopback, private, link-local, CGNAT, multicast, ULA and
  cloud-metadata ranges; the connection is made to the checked address
  (pinned, so DNS rebinding cannot swap it); redirects are not followed;
  responses are size- and time-capped and never stored beyond a short
  excerpt.
- Delivery is at-least-once with exponential backoff and jitter, a bounded
  retry budget, automatic disabling after sustained failure, a per-delivery
  log, manual replay and a test ping.
- A subscription is Workspace-scoped; an event is emitted only to
  subscriptions with the event's `workspaceId`.

## Onboarding (phase 3)

API signup creates a user, Workspace and bootstrap token in one call, hosted
only. Email verification and Stripe Checkout remain human gates. The bootstrap
token starts restricted (reads plus Product and webhook setup) until the
account email is verified; sensitive scopes, outbound replies and paid
features are unlocked only after the human gates. Abuse controls: per-IP and
per-email rate limits, disposable-domain policy (open question), a Turnstile
or proof-of-work challenge (open question) and a hard cap on unverified
Workspaces per IP and per day. Self-hosted mode has no API signup (one
Workspace, created at first run) and never needs Stripe (FR-HOST-01).

## Parity rule

Every dashboard capability has an API equivalent, enforced by a test rather
than by intent: a checked-in manifest maps each dashboard server action
(`src/app/**/actions.ts`) to an OpenAPI `operationId` or to an explicit
exemption with a reason (for example sign-in, password reset, billing portal).
A test fails if a server action is missing from the manifest, if a mapped
`operationId` does not exist, or if an exemption lacks a reason. See the plan.

## Consequences

- New tables (`ApiAuditLog`, `IdempotencyKey`, `WebhookEndpoint`,
  `WebhookDelivery`, plus `Message.authorTokenId` and assignment columns from
  the V2 assignment design) arrive with their phases, each as a hand-written
  migration; this ADR only specifies them.
- The existing Product routes and their drift test keep working. New routes
  extend the OpenAPI document in the phase that implements them; until then
  the contract is a draft in [openapi-draft.json](../openapi-draft.json),
  which `openapi-drift.test.ts` does not scan, because that test requires the
  documented paths to equal the route files exactly.
- The dashboard is not rewritten to use the API; parity is capability parity,
  not shared code. Where a shared core already exists (for example
  `listConversations`, `patchProduct`) the API reuses it.
- Rate limits stay per process; a multi-process deployment weakens per-token
  limits proportionally. Phase 1 documents this; a shared limiter is out of
  scope (no Redis without measured need, architecture.md).
- Outbound webhooks and API signup are the two features that talk to the
  outside world or create tenants without a human at a keyboard. They carry
  the highest abuse risk and therefore ship last and behind the isolation
  suite.

## Alternatives rejected

- **Session cookies for agents.** Not revocable per agent, not scoped, and
  hands over a human login.
- **Per-route ad hoc scoping.** The status quo for the dashboard. It works
  with review discipline but a missed `workspaceId` is a cross-tenant leak;
  for a public API the data layer enforces it instead.
- **Postgres row-level security as the only guard.** Strong, but needs a
  session variable per request through Prisma and PGlite parity in tests; kept
  as a possible later second layer (open question), not a blocker.
- **Build a CLI.** Out of scope by direction; the API and later MCP server
  cover agents.
