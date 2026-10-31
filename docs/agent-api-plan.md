# Agent-first Workspace API: phased plan and spec

Status, 2026-10-31: slices 1a, 1b and 1d are built (scope registry and scoped data layer, `whoami`; signed cursors, idempotency store and audit log; `createMessage` and `updateConversation`). The rest is still specification; the document itself ships no code.
Decision record: [ADR-0005](adr/0005-agent-first-workspace-api.md). Requirements:
FR-API-01 (amended) and FR-API-04..FR-API-17 in [FRD.md](FRD.md). Draft contract:
[openapi-draft.json](openapi-draft.json) (phase 1 only; see
[Contract and drift test](#contract-and-drift-test)). Questions that need the
maintainer: [open-questions.md](open-questions.md#agent-first-workspace-api-2026-10-29)
(AA2..AA21 below; AA1 is resolved).

**Goal.** An AI agent can onboard a Workspace and run support (conversations,
replies, notes, tags, status, contacts, saved replies, products, webhooks,
tokens) using HTTP only, with no dashboard. A remote MCP server follows later as
a thin wrapper. There is no CLI.

**Top requirement: tenant isolation.** Nobody can read or change another
tenant's conversations, messages, contacts, attachments, products, webhooks or
tokens. Section [Tenant isolation](#tenant-isolation) is normative and applies
to every phase; the tests in [Required tests](#required-tests-per-phase) are the
acceptance gate of each phase.

## What exists today (reused, not reinvented)

| Piece | Where | Reuse |
| --- | --- | --- |
| Bearer token auth: `ss_live_` + 43 base64url, SHA-256 at rest, tenant from the token row | `src/lib/api-tokens.ts`, `src/lib/admin-api.ts` | Same tokens; add scopes |
| Error envelope `{error:{code,message,details?}}`, `private, no-store` | `src/lib/api-errors.ts` | Same; add a few codes |
| Rate limits: 30 writes/min/token, 20 failed auths/min/IP, `clientIp()` | `src/lib/widget-rate-limit.ts`, `src/lib/client-ip.ts` | Same buckets; add read and reply buckets |
| Body cap 64 KiB, strict zod bodies | `src/lib/product-api.ts` | Same |
| Conversation core: list (cursor, status, product, search, limit ≤100), detail, reply, status, tags | `src/lib/conversations.ts` | Reuse service functions behind the scope layer |
| Free-plan pause (`402 service_paused` blocks agent replies, not notes/tags/status) | `src/lib/service-pause.ts` | Same rule for API replies |
| OpenAPI 3.1 + drift test | `docs/openapi.json`, `src/lib/__tests__/openapi-drift.test.ts` | Extend per phase |
| Two-Workspace cross-tenant tests | `src/lib/__tests__/cross-tenant.test.ts` | Extend into an API suite |

Facts that shape the design: `Message` has no `workspaceId` (it is scoped through
`Conversation`); `Attachment`, `Contact`, `Tag`, `SavedReply`, `Product`,
`Conversation` and `ApiToken` do carry one. `Message.agentUserId` is the only
author field, so a token-authored reply needs a new nullable `authorTokenId`.
Assignment and priority have no schema yet (V2 design:
[design/assignment-priority.md](design/assignment-priority.md)). Rate limits are
in-process (per process on a multi-process self-hosted deployment).

## Tenant isolation

### 1. Tenant resolution: token only

- The Workspace of a request is `ApiToken.workspaceId` of the presented token.
  Nothing in the body, path, query, cookie or any other header can select,
  override or hint a Workspace. No endpoint takes `workspaceId` as an input,
  and the OpenAPI draft has no such parameter.
- Handlers receive a `WorkspaceScope` (`{ workspaceId, tokenId, scopes }`)
  created by the auth wrapper, never a bare string they could replace.
- Writes accept tokens only. A request with an `Authorization` header is
  judged on the token alone (existing rule). A dashboard session cookie is
  never accepted anywhere on `/api/v1`, reads included. Only the frozen
  `/api/products` alias keeps the cookie reads FR-API-02 already allows, to
  keep today's behaviour.

### 2. The choke point: `scopedDb`

A single module, `src/lib/workspace-scope.ts`, is the only data access API code
may use. It returns a Prisma client extended with a query extension
(`$extends({ query: { $allModels: { $allOperations } } })`) bound to one
`workspaceId`:

| Operation family | Enforcement |
| --- | --- |
| `findMany`, `findFirst`, `findFirstOrThrow`, `count`, `aggregate`, `groupBy`, `updateMany`, `deleteMany` | `workspaceId` ANDed into `where` |
| `create`, `createMany` | `workspaceId` forced on `data` (a differing value throws) |
| `findUnique`, `findUniqueOrThrow`, `update`, `delete`, `upsert` | Rewritten to the scoped `findFirst` / `updateMany` / `deleteMany` form, so an id alone never selects a row |
| Models without `workspaceId`: `Message`, `ConversationTag`, `SavedReplyProduct`, `MessageReadReceipt` (via their Conversation or SavedReply) and `ChatVisitor`, `ProductDomain`, `ProductMailDomain`, `WidgetHostSignal` (via their Product; `ChatVisitor.conversationId` is nullable, so a visitor with no Conversation is still reachable only through its Product). `DiagnosticSnapshot` has its own `workspaceId` and takes the direct filter | Reached only through the parent relation filter (`where: { conversation: { workspaceId } }`); a direct query without it throws |
| Nested writes (`connect`, `connectOrCreate`, relation `create`) | The extension walks the args and rejects any `connect` to a row outside the scope (a foreign `productId` surfaces as the same `404` as an unknown one) |

Rules that make the choke point a guarantee instead of a convention:

1. **Registry.** `TENANT_MODELS` classifies every Prisma model as
   `direct` (has `workspaceId`), `via:<parent>` (scoped through a parent) or
   `global` (no tenant data, for example session or verification tables, and
   never reachable from the API). A test iterates `Prisma.dmmf.datamodel.models`
   and fails when a model is unclassified, so adding a table forces the
   decision.
2. **Lint.** ESLint `no-restricted-imports` for `src/app/api/v1/**` and
   `src/lib/api/**` forbids `@/lib/prisma`, `@/generated/prisma/*` and
   `@prisma/client`; the only permitted data import is `@/lib/workspace-scope`.
   `no-restricted-syntax` forbids `$queryRaw`, `$executeRaw`, `$queryRawUnsafe`
   and `$executeRawUnsafe` in the same paths.
3. **Static test** (backs up the lint, which can be disabled by a comment): a
   vitest test parses every file under those paths and fails on the same
   patterns, and on any `route.ts` that does not export its handlers through
   the `v1Route({ scope, ... })` wrapper (which authenticates, rate-limits,
   applies idempotency and audit, and builds the `WorkspaceScope`).
4. **Property test.** For every `direct` and `via:` model and every operation
   family, run the call as Beta against rows that exist only in Alpha and
   assert zero rows read, zero rows changed.
5. **Escape hatch is explicit.** Anything that must cross tenants (for example
   the webhook delivery worker reading its own outbox, or signup creating a new
   Workspace) lives outside `src/app/api/v1/**`, in a named internal module
   listed in the test as an allowed exception with a reason.

Dashboard code is out of scope for migration (AA19). It keeps its existing
checks and the existing cross-tenant tests.

### 3. Cross-tenant ids answer like unknown ids

- A path id, body id (`productId`, `savedReplyId`, `tagId`, `assigneeId`,
  `attachmentIds`), filter id or cursor from another Workspace produces
  exactly the response an unknown id produces: same status, same JSON body
  (including `message` and absent `details`), same header set. Existence is
  never confirmed, including through `409` or `422` on a foreign id.
- Because the scoped query never sees the foreign row, both paths run the same
  code. A deterministic proxy for timing is tested: the number of database
  statements issued for a foreign id equals the number for an unknown id.
  Wall-clock timing is not asserted in CI (flaky).
- Token failures stay indistinguishable (existing rule). A missing scope is
  `403 insufficient_scope`, which names only the required scope.

### 4. No enumeration side channels

| Channel | Control |
| --- | --- |
| Ids | Random UUIDs. Human references (`SS-123`) are accepted only as a filter inside the scope. |
| Pagination cursors | Opaque. `base64url(payload) + "." + HMAC-SHA256(key, workspaceId \| route \| resolved path ids \| filterHash \| payload)`. The key is derived (HKDF, fixed context label) from the existing `BETTER_AUTH_SECRET`; no new required environment variable. Wrong Workspace, route, parent id (a cursor minted under one Conversation is useless under another), filters, tampering or truncation all yield the same `400 invalid_cursor`. The payload carries only sort keys of rows the caller can already see. |
| List totals | None. Lists return `items` and `nextCursor`, never a total. |
| Error messages | Generic; never echo foreign data; `details` names only fields of the caller's own request. |
| Attachment URLs | Attachments are served only at `GET /api/v1/attachments/{id}/content` with the bearer token, scoped like every resource and `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`. No public, unauthenticated or presigned URL, and no storage key in any response or webhook. |
| Webhook payloads | Built inside the delivery worker from scoped reads keyed by the subscription's `workspaceId`. A subscription only ever receives events carrying its own `workspaceId`. Payloads carry attachment metadata and ids, not fetchable URLs. |
| Idempotency keys | Scoped to (Workspace, token, method, resolved path with its ids); replays never cross Workspaces or resources. |
| Response caching | `private, no-store` on every response (existing). |
| Logs | Request id, token id, Workspace id, operation id. Never tokens, secrets or message bodies (FR-OPS-01). |

### 5. Accountability and abuse limits

| Control | Spec |
| --- | --- |
| Scopes | Least privilege, see [Scopes](#scopes). A created token's scopes must be a subset of its creator's scopes, and `tokens:admin` can never be put on an API-created token: it is granted only in the dashboard (AA9), so a leaked admin token cannot mint an unexpiring clone of itself and then revoke the original. |
| Expiry | Tokens created through the API require an explicit `expiresAt` (maximum 365 days; no server default, omission is `400`; 90 days is the documented example); `expiresAt: null` is refused through the API (AA8). Dashboard tokens keep their optional expiry. |
| Revocation | Immediate (existing). A token may revoke itself. `DELETE /api/v1/tokens/{id}` is idempotent. |
| Rate limits (defaults, AA11) | Per token: 120 reads/min, 30 writes/min (existing), 20 replies/min, 10 token-admin writes/min. Per IP: 20 failed auths/min (existing) and 300 requests/min across tokens. `429 rate_limited` with `Retry-After`. In-process (documented limitation). |
| Body caps | 64 KiB JSON (existing). Attachment upload: FR-FILE-01 size and MIME rules. |
| Audit log | Append-only `api_audit_log`: workspace, token, operation id, resource type and id, request id, client IP, status, timestamp. Written for every token-authenticated write, token create/revoke and denied cross-scope attempts. Denied attempts are bounded so a flood of foreign ids cannot grow the table: the first 20 per token per hour are stored in full, later ones only increment a `suppressedCount` on the last stored row. The 90-day retention (AA10) covers every row. No bodies, no secrets. Read through `GET /api/v1/audit-log` (`audit:read`, cursor-paged, scoped) and later the dashboard (AA10). |
| Idempotency | `Idempotency-Key` on every create/send write; below. |

### Idempotency spec

`Idempotency-Key: <1-128 chars, [A-Za-z0-9_-]>` is honoured on `POST` and on
`PUT`/`PATCH`/`DELETE` that are not naturally idempotent. A key is stored for 24
hours as (workspace, token, method, resolved path with its ids, key, request hash,
response status and body), so the same key on a different Conversation never
replays another resource's response. Same key and same body: the stored response is replayed with
`Idempotent-Replayed: true`. Same key, different body: `409
idempotency_conflict`. Same key while the first request is still running: `409
idempotency_in_flight` with `Retry-After`. Replies and webhook test pings
require the header (`400` if absent) because they have an outward side effect.
Stored response bodies contain only the caller's own data and are purged lazily
after 24 hours.

## Scopes

Scopes are a registry (`src/lib/api-scopes.ts`) mapping each scope to the
operations it allows; `scopesGrant(scopes, capability)` stays the single check.
Implication is explicit and one-directional: `x:write` implies `x:read`, and `conversations:read` also implies `attachments:read` (Messages already expose attachment ids, so a reader must be able to fetch them).
`products:write` keeps its meaning and keeps implying `products:read`, so
existing tokens and the published quickstart are unaffected. Dashboard-created
tokens keep getting only `products:write` unless an admin picks more (AA7). Interim, by maintainer instruction on 2026-10-31, new dashboard tokens also get `conversations:reply` and `conversations:write` until the picker lands (see AA7).

| Scope | Grants | Implies |
| --- | --- | --- |
| `products:read` | List/get Products | n/a |
| `products:write` | Create/edit Products and domains | `products:read` |
| `conversations:read` | List/get Conversations, Messages, Tags, tag list | n/a |
| `conversations:write` | Status, tags, internal notes | `conversations:read` |
| `conversations:reply` | Send agent replies (outbound to a customer; separate because it has a real-world effect) | `conversations:read` |
| `conversations:assign` | Assign (after the assignment schema, AA4) | `conversations:read` |
| `conversations:delete` | Delete a Conversation and its attachments (Admin-equivalent, FR-ACC-01) | `conversations:read` |
| `contacts:read` | List/get Contacts | n/a |
| `contacts:delete` | Delete a Contact (FR-SEC-02) | `contacts:read` |
| `saved-replies:read` / `saved-replies:write` | List/get; create/edit/delete | write implies read |
| `attachments:read` | Fetch attachment metadata and content | also implied by `conversations:read` |
| `webhooks:read` / `webhooks:write` | List/get subscriptions and deliveries; create/edit/delete, rotate, replay, test | write implies read |
| `tokens:admin` | List/create/revoke tokens | n/a |
| `audit:read` | Read the audit log | n/a |
| `workspace:read` / `workspace:write` | Workspace info, availability (Live/Away) and billing status read; change availability | write implies read |
| `team:write` | Invite or remove members (sends mail to third parties; never in a default preset) | `workspace:read` |
| `billing:write` | Create a Stripe Checkout URL (hosted only) | `workspace:read` |

## API surface

All paths are under `/api/v1`. Bodies are `strictObject` JSON; unknown fields
are `400`. Dates are ISO 8601 UTC. Every list takes `limit` (1-100, default 25)
and `cursor`. Every write returns the resulting resource. The full draft schema
is in [openapi-draft.json](openapi-draft.json).

### Phase 1 operations

| Operation (`operationId`) | Method and path | Scope | Idempotency-Key | Dashboard equivalent (parity) |
| --- | --- | --- | --- | --- |
| `whoami` | `GET /whoami` | any valid token | n/a | n/a (token introspection: Workspace name, token id/name, scopes, expiry) |
| `listProducts` / `getProduct` / `createProduct` / `updateProduct` | `/products`, `/products/{id}` | `products:*` | create | Settings → Products |
| `listConversations` | `GET /conversations` (`status`, `productId`, `tag`, `contactId`, `q`, `updatedAfter`) | `conversations:read` | n/a | Inbox list and search |
| `getConversation` | `GET /conversations/{id}` | `conversations:read` | n/a | Conversation view |
| `listMessages` | `GET /conversations/{id}/messages` | `conversations:read` | n/a | Thread |
| `createMessage` | `POST /conversations/{id}/messages` `{kind: "reply"\|"note", body, savedReplyId?, attachmentIds?}` | `conversations:reply` for `reply`, `conversations:write` for `note` | required | Reply and internal note composer |
| `updateConversation` | `PATCH /conversations/{id}` `{status?, addTags?, removeTags?}` | `conversations:write` | optional | Close/reopen, tags |
| `setAssignee` | `PUT /conversations/{id}/assignee` | `conversations:assign` | optional | Assign (slice 1f) |
| `deleteConversation` | `DELETE /conversations/{id}` | `conversations:delete` | n/a (idempotent by nature) | Delete (Admin) |
| `listTags` | `GET /tags` | `conversations:read` | n/a | Tag picker |
| `listContacts` / `getContact` | `GET /contacts`, `/contacts/{id}` | `contacts:read` | n/a | Contact panel |
| `deleteContact` | `DELETE /contacts/{id}` | `contacts:delete` | n/a | FR-SEC-02 |
| `listSavedReplies`, `getSavedReply`, `createSavedReply`, `updateSavedReply`, `deleteSavedReply` | `/saved-replies`, `/saved-replies/{id}` | `saved-replies:*` | create | Saved replies page |
| `getAttachment` / `getAttachmentContent` | `GET /attachments/{id}`, `/attachments/{id}/content` | `attachments:read` (also implied by `conversations:read`) | n/a | Attachment download |
| `createAttachment` | `POST /attachments` (multipart `file` plus `conversationId`; the Product comes from the Conversation, a foreign id is `404`; staged until referenced) | `conversations:reply` or `conversations:write` | optional | Composer upload |
| `listTokens` / `createToken` / `revokeToken` | `/tokens`, `/tokens/{id}` | `tokens:admin` | create | Settings → API tokens |
| `getWorkspace` / `setAvailability` | `GET /workspace`, `PATCH /workspace` | `workspace:read`/`write` | optional | Availability toggle |
| `listAuditLog` | `GET /audit-log` | `audit:read` | n/a | n/a (new) |

Semantics worth fixing now:

- **Replies** (`createMessage`, `kind: "reply"`) reuse the dashboard reply path
  (`deliverAgentReplyIfRouted`): same routing (chat or email), same Free-plan
  pause (`402 service_paused`, added to the error table), reopen of a Closed
  Conversation (decided D3), once-ever billing count unchanged. The message is
  authored by the token: `Message.authorTokenId` (nullable FK to `ApiToken`,
  `SetNull`) is stored, and the inbox shows `<token name> (API)`. The response
  carries `delivery: { state: "queued" | "sent" | "failed" | "not_applicable" }`
  so an agent sees a failed email without polling the dashboard (FR-EMAIL-03).
- **Notes** never reach the customer and are allowed during the Free pause
  (same as the dashboard).
- **Messages are append-only** over the API; there is no edit or delete of a
  single message (the dashboard has none).
- **`updateConversation`** applies status and tag changes together or not at
  all, like `patchProduct`; a no-op body is `400`.
- **Search** (`q`) uses the existing Workspace-scoped search; it never searches
  outside the scope.

### `/api/v1` versus `/api/products` (AA3)

`/api/v1` is canonical for new work. `/api/products` and `/api/products/{id}`
stay as a permanent, frozen alias: same handlers, same `{ "products": [...] }`
list shape the published quickstart documents, same behaviour and limits, and
the existing drift test keeps covering them unchanged. `/api/v1/products` shares
the service functions but uses the v1 envelope (`{ items, nextCursor }`) and,
from phase 2, additionally returns the `installation` block. The alias is not
deprecated or sunset by this plan; changing that is a maintainer decision.

## Phased delivery

Each phase ships as a **stack of slices, one PR per slice, each under 600
meaningful changed lines** (AGENTS.md). The brief asked for one PR per phase;
phase 1 cannot honestly fit in one, so it is sliced (AA2). Every slice ends with
`npm run verify` green and its cross-tenant tests merged in the same PR.

### Phase 1: Conversations API

| Slice | Content | Notes |
| --- | --- | --- |
| 1a Foundation | `workspace-scope.ts` + `TENANT_MODELS` registry + lint rule + static test; scope registry (`api-scopes.ts`) with the existing scope unchanged; `v1Route` wrapper; the Alpha/Beta API harness and the coverage-manifest test; `whoami` | No endpoints with data yet, so the harness lands before anything it must protect |
| 1b Cross-cutting | cursor signing helper; the `/api/v1` router and the `/api/products` alias move are deferred (see slice status below); idempotency store; `api_audit_log`; no new error code yet: `openapi-drift.test.ts` fails when an `API_ERROR_STATUS` code has no documented response, so each code lands with the slice that first emits and documents it (`invalid_cursor` in 1c, `idempotency_conflict`, `idempotency_in_flight` and `service_paused` in 1d) | Migration: two tables |
| 1c Read API | `listConversations`, `getConversation`, `listMessages`, `listTags`, `listContacts`, `getContact`, `getAttachment`(+content) | Migration: none |
| 1d Write API | `createMessage` (reply and note), `updateConversation`; `Message.authorTokenId` | Migration: one column; inbox label for token authors |
| 1e Saved replies, attachments, tokens | saved-replies CRUD, `createAttachment`, `listTokens`/`createToken`/`revokeToken`, `getWorkspace`/`setAvailability`, `listAuditLog`, delete operations | If this exceeds 600 lines, split tokens and audit read into a further slice (1e2) |
| 1f Assign | `setAssignee` and the `assigneeId` field in responses | Not part of phase 1 delivery: depends on the V2 assignment/priority schema (AA4) and ships with it. Phase 1 is slices 1a-1e; the draft contract marks the operation `blocked` |

Slice status: 1a delivered. 1b delivered as internal modules (`src/lib/api/cursor.ts`, `idempotency.ts`, `audit.ts`, tables `api_audit_log` and `idempotency_keys`; the audit write is part of `v1Route`, which now requires an `operationId`). The `/api/v1/products` routes and the `/api/products` alias move are not in 1b: the plan defines no v1 Product shape, and the alias keeps its current behaviour either way (FR-API-04), so they wait for a slice that needs them. Idempotency is wired into `v1Route` in 1d, with its error codes.

Phase 1 exit criteria: every dashboard Conversation capability except sign-in
flows is reachable by a scoped token, the parity test (below) passes for
Conversations, and the cross-tenant suite covers every operation.

### Phase 2: Outbound webhooks and one-call Product setup

| Slice | Content |
| --- | --- |
| 2a Subscriptions | `webhook_endpoints` table; `listWebhooks`, `getWebhook`, `createWebhook`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret` (`webhooks:*`); secret shown once at creation and rotation; SSRF validation of the URL at create/update |
| 2b Emission and delivery | `webhook_events` outbox written in the same transaction as the domain change; delivery loop with backoff; HMAC signing; SSRF guard at connect time |
| 2c Operability | `listDeliveries`, `getDelivery`, `replayDelivery`, `sendTestPing`; auto-disable after sustained failure; admin email on disable |
| 2d One-call Product | `POST /api/v1/products` response gains `installation`: `widgetSnippet`, `widgetScriptUrl`, `inboundEmail`, `formEndpoint`; origins derived from the request, never `NEXT_PUBLIC_APP_URL` (AGENTS.md: apex routers still reach this app) |

**Events** (`type` in the payload and the `SupportSeal-Event` header):
`conversation.created`, `conversation.status_changed`,
`conversation.tags_changed`, `conversation.assigned` (after 1f),
`message.received` (customer message, chat or email), `message.sent` (agent
reply accepted, with delivery state), `message.delivery_failed`,
`note.created`, `contact.created`. Envelope:

```json
{ "id": "evt_...", "type": "message.received", "createdAt": "2026-10-29T10:00:00Z",
  "apiVersion": "2026-10-29", "workspaceId": "...", "data": { "conversationId": "...", "message": { "id": "...", "kind": "CUSTOMER", "body": "..." } } }
```

`workspaceId` in the envelope is the subscriber's own and lets a receiver
sanity-check which Workspace a shared endpoint is serving (AA12).

**Signing.** `SupportSeal-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is
HMAC-SHA256 over `"<t>.<raw body>"` with the subscription secret
(`whsec_` + 32 random bytes base64url, shown once, stored encrypted-at-rest
or as a keyed hash is not possible because the server must sign: stored with
application-level encryption using `WEBHOOK_SECRET_KEY` when set (hosted
requires it, so rotating the auth secret never breaks receivers) and otherwise
a key derived from `BETTER_AUTH_SECRET`; AA12 notes the rotation consequence). Receivers reject `t` older than 5 minutes
(documented replay window) and compare in constant time. `SupportSeal-Delivery`
carries a unique delivery id receivers use to deduplicate (delivery is
at-least-once). Secret rotation sends both `v1` signatures (old and new) for a
24-hour overlap.

**SSRF protection** (applied at create/update and again on every delivery
attempt):

1. Scheme must be `https`, port 443 or a non-reserved port; no credentials in
   the URL; hostname length bound; punycode normalised.
2. Resolve the hostname; **every** returned address must be public. Block
   loopback, RFC 1918, link-local (169.254.0.0/16 including cloud metadata
   169.254.169.254, fe80::/10), CGNAT 100.64.0.0/10, multicast, broadcast,
   documentation and benchmarking ranges, IPv4-mapped IPv6 forms of all of the
   above, `0.0.0.0/8`, ULA fc00::/7, and cloud metadata hostnames. IP literals
   in the URL are checked the same way.
3. Connect to the **checked address** (pin it; present the original hostname
   for SNI/Host) so a DNS answer that changes between check and connect (DNS
   rebinding) cannot reach an internal address. The re-check on every attempt
   covers records that change over time.
4. **No redirects** are followed; a `3xx` is a failed attempt.
5. Connect, response-header and total timeouts (5 s / 10 s / 15 s); the
   response body is read up to 4 KiB for the delivery log and discarded.
6. Self-hosted operators who must reach a private receiver use an explicit
   host allow-list in the environment (AA14); there is no "disable the guard"
   switch.

**Retries.** A delivery succeeds on any `2xx`. Otherwise retry with exponential
backoff and jitter (30 s, 2 min, 10 min, 1 h, 6 h, 24 h; six retries, then
`FAILED`). A subscription whose deliveries fail continuously for 3 days is
disabled and Workspace admins are emailed (AA15). The delivery log keeps 14 days
(attempt time, status, latency, response excerpt). `replayDelivery` re-sends the
stored payload with a fresh timestamp and signature.

**Isolation specifics.** The outbox row and the subscription both carry
`workspaceId`; the worker joins on equality in SQL and re-checks it in code
before signing. The worker is the one internal module allowed outside
`scopedDb` (it reads the outbox across Workspaces by design) and is covered by
its own test: an event from Alpha never reaches a Beta subscription, and a
payload never contains an id from another Workspace.

**Infrastructure note (needs Pete, AA13).** The repo has no scheduler. The
delivery loop is the first long-lived background activity. Recommendation: an
in-process bounded polling loop started from `instrumentation.ts`, consistent
with ADR-0003's database-polling decision, no new service and no Redis. The
alternative is an external cron calling a protected endpoint.

### Phase 3: Agent onboarding (hosted only)

| Slice | Content |
| --- | --- |
| 3a Signup | `POST /api/v1/signup` creates a pending account, an unverified Workspace and a bootstrap token in one call |
| 3b Billing | `GET /api/v1/billing` (plan, usage, grace/pause state, whether checkout is available) and `POST /api/v1/billing/checkout` returning the Stripe Checkout URL (the human pays) |
| 3c Abuse controls | Per-IP and per-email quotas, challenge hook, unverified-Workspace limits and expiry |

**Signup without enumeration (AA16).** `POST /api/v1/signup { email,
workspaceName, productName? }` always answers `201` with the same shape: a
`workspaceId`, a bootstrap token (`ss_live_`, restricted, 7-day expiry) and
`verification: "email_sent"`. It does not reveal whether the email already has
an account. Mechanism: the signup creates a *pending* identity that does not
claim the email; the verification mail's link lets the human set a password and
claim the Workspace. If the address already belongs to a verified user, the
mail says so and the pending Workspace can never be claimed, so it is deleted at
expiry. Agents therefore get a working token either way, and an attacker
learns nothing.

**Human gates.**

1. *Email verification.* Until verified, the bootstrap token holds only
   `products:write`, `conversations:read`, `contacts:read`,
   `saved-replies:write`, `workspace:read`: it can set up and read, but cannot
   send customer email (`conversations:reply`), create webhooks (an outbound
   relay to third-party URLs), create tokens, invite members or start
   checkout. Verification adds the scopes the human approves.
2. *Payment.* The agent calls `POST /billing/checkout` and hands the returned
   Stripe URL to the human. The Free plan needs no payment. Stripe Checkout is
   hosted-only; self-hosted deployments return `404` for billing routes and never
   need Stripe (FR-HOST-01).

**Abuse controls.** Per-IP (10 signups/min existing sign-up limit plus 5/day per
IP), per-email (1 verification mail per address per hour, 3 per day, which
bounds email-bombing a victim), a global kill switch, optional challenge
(proof-of-work or a CAPTCHA, AA17), at most 3 Products and no outbound replies
while unverified, and automatic deletion of Workspaces unclaimed after 7 days
(AA18). Signup is rate-limited before any database write and its failures are
audit-logged at the IP level.

**Self-hosted.** `POST /signup` and billing return `404`. A self-hosted
installation has exactly one Workspace created at first run; its first token is
minted in the dashboard with `tokens:admin`; agents then mint narrower
tokens (never `tokens:admin` themselves) through the API.
An agent-assisted first-credential path for self-hosted installations is
proposed, not decided, in [ADR-0006](adr/0006-agent-bootstrap-credentials.md).

**Spike required before 3a.** Workspaces are currently created only with an
owning user and an ADMIN membership (`createWorkspace`). An ownerless pending
Workspace needs a small design spike (a `claimedAt`/`pendingOwnerEmail` column
set versus a placeholder user); the result updates this section, not the ADR.

### Phase 4 (later): MCP and discoverability

- A remote MCP server (streamable HTTP) that exposes each API operation as a
  tool, one-to-one with `operationId`, generated from the OpenAPI document.
  It authenticates with the same bearer tokens, enforces the same scopes, and
  has no data access of its own (it calls the HTTP API), so it cannot add a
  tenant-isolation hole. Tool lists are filtered by the token's scopes. No new
  capability appears in MCP before it exists in the API.
- `llms.txt` and an agent-oriented quickstart on the marketing site. The
  marketing site is the private `supportseal-marketing` repository; this note
  is the only action here (AGENTS.md: never add marketing pages to this repo).

## Required tests per phase

Every slice that adds an endpoint ships these in the same PR. A phase is not
done until all hold.

1. **Alpha/Beta cross-tenant integration suite** (in-memory PGlite, same
   fixture as `cross-tenant.test.ts`, per docs/FRD.md acceptance path: Alpha with
   two Products, Beta with one, each with users, contacts, chats, emails,
   attachments, saved replies, webhooks and tokens, every record carrying a
   unique canary string). For **every** endpoint in the OpenAPI document, call it
   with Beta's token and Alpha's real ids in every position (path, query,
   body, nested ids, cursor, `Idempotency-Key` replay) and assert: status and
   body equal the baseline for a never-existing id (404, or 400 for a cursor);
   Alpha's canary appears nowhere in the response, headers or error; Alpha's
   data is unchanged afterwards; and the number of statements issued equals the
   unknown-id baseline.
2. **Coverage manifest test.** The suite records each `operationId` it
   exercises; a final test fails if any operation implemented under
   `src/app/api/v1` (a route file exists) was not exercised, so a new endpoint
   cannot ship untested. Draft operations with no route yet and operations
   marked `x-status: blocked` (`setAssignee`) are excluded until their slice
   implements them, so the test is green from slice 1a.
3. **Unscoped-Prisma gate.** The ESLint rule and the static test from
   [The choke point](#2-the-choke-point-scopeddb), plus the `TENANT_MODELS`
   classification test and the per-model property test. CI (and the local
   `verify`) fails if an API route imports Prisma or uses raw SQL.
4. **Fuzz of guessed ids and cursors.** Property-based (fast-check or a seeded
   loop; deterministic seed in CI) generating: random UUIDs; Alpha's UUIDs with
   case changes, whitespace, `%`-encoding, trailing slashes, unicode
   look-alikes and SQL/NoSQL fragments; oversized and empty values; for cursors
   random bytes, truncations and single-bit flips of a valid Alpha cursor and
   Alpha cursors replayed against Beta, other routes and other filters. Each
   response must be byte-identical to the baseline for its class and never
   `5xx`.
5. **Scope matrix.** For each endpoint, a token lacking the scope gets
   `403 insufficient_scope`, a token with it succeeds, and `tokens:admin` token
   creation cannot exceed the creator's scopes.
6. **Idempotency, pagination and rate-limit contract tests** (replay returns the
   stored response, conflict on body change, cursors are stable under inserts,
   `429` with `Retry-After`).
7. **Audit log test.** Every token-authenticated write produces exactly one row
   with no body or secret content; denied attempts are logged.
8. **Browser smoke (AGENTS.md).** Phase 1: create a token with scopes in the
   dashboard, run the quickstart sequence against `next dev`, confirm the
   token-authored reply appears in the inbox as `<name> (API)` and a widget
   visitor receives it. Phase 2: a local receiver verifies a signature, a
   replayed old timestamp, a redirecting target and a private-IP target.
   Phase 3: signup, email verification in the dev mail sink, checkout URL
   returned.

Phase 2 additions: SSRF unit tests against a table of hostile URLs and
resolver answers (IPv4-mapped IPv6, decimal/octal/hex IP forms, rebinding
resolver that changes its answer between calls, redirect to a private IP);
signature tests (tamper, replay window, rotated-secret overlap); the
Alpha-event-never-reaches-Beta subscription test; retry/backoff and
auto-disable tests with a fake clock.

Phase 3 additions: signup response identical for new and existing emails;
quota and email-bombing caps; unverified-token scope restriction; self-hosted
returns `404`.

## Parity rule: every dashboard capability has an API equivalent

Enforced by a test instead of by intent:

1. `src/lib/api-parity.ts` is a checked-in manifest keyed by dashboard server
   action (`file#export`, for each `export async function` in
   `src/app/**/actions.ts`) with either `{ operationId }` or `{ exempt: "<reason>" }`.
   Exemptions are the human-only set: sign-in, password reset, session and
   account management, Stripe customer portal, invite acceptance, and
   anything the API deliberately does differently (reason required).
2. `api-parity.test.ts` fails when (a) a server action exists that is not in
   the manifest, (b) a mapped `operationId` is not in the OpenAPI document
   (draft or final), (c) an exemption has an empty reason, or (d) a manifest
   entry names a removed action. Adding a dashboard feature without deciding its
   API story therefore breaks `verify:fast`.
3. The manifest starts with every current action classified (most map to the
   Phase 1-3 operations; unmapped ones are listed with a tracking issue until
   their phase lands, and the test allows `{ planned: "<phase and slice>" }`
   only for operations in this plan, with the planned set shrinking to empty by
   the end of phase 3).
4. The AGENTS.md "Important invariants" section gains one line pointing here,
   so the rule is read by contributors; the test is what enforces it.

## Contract and drift test

`docs/openapi.json` is currently the contract for the Product API and is held to
exact equality with the route files by `openapi-drift.test.ts` (paths, methods,
statuses, error codes, schemas, and the numbers quoted in `openapi.json`,
`api-quickstart.md` and `api-tokens.md`). Adding the new paths there before the
routes exist would fail that test, so the phase 1 draft lives in
[openapi-draft.json](openapi-draft.json), marked `x-status: draft`, and is not
scanned. Each implementing slice moves its operations from the draft into
`openapi.json` and extends the drift test to the `/api/v1` route tree in the
same PR; the draft file is deleted when empty. Keep the docs the drift test reads
free of numbers that would then need to match the draft.

## Dependencies and risks

- **Assignment (1f)** depends on the V2 assignment/priority schema (AA4).
- **Tokens-as-authors** adds a column and an inbox label (1d).
- **Delivery worker** is the first background loop (AA13).
- **Ownerless pending Workspace** needs a spike before 3a.
- **In-process rate limits** weaken per-token limits on multi-process
  deployments (documented; no Redis without need).
- **Stored webhook secrets** must be recoverable to sign, so they are encrypted
  with `WEBHOOK_SECRET_KEY` (hosted, required) or a key derived from the
  server secret (self-hosted default); rotating `BETTER_AUTH_SECRET` then
  invalidates self-hosted secrets, which the rotation docs must call out.
- **Prisma extension coverage** depends on Prisma 7 behaviour for nested
  writes; slice 1a includes a proof test per operation family before any
  endpoint relies on it. If a family cannot be enforced in the extension, the
  fallback is a hand-written repository per model with the same lint gate.
- **Reply abuse by a leaked `conversations:reply` token** is bounded by the
  reply rate limit and the audit log, not eliminated; a human-approval mode is
  out of scope (AA6).

## Questions for the maintainer

The list, defaults and recommendations are in
[open-questions.md](open-questions.md#agent-first-workspace-api-2026-10-29)
(AA2..AA21). None is guessed in this plan; each shows the working position this
document assumes so work can start, and nothing ships against a position the
maintainer has not confirmed for the slice that depends on it.
