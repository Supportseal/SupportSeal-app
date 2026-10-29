# ADR 0006 — Agent bootstrap credentials

Status: **Proposed, needs maintainer sign-off.** Design only; no code ships with this ADR. Every security-relevant choice below is an open question ([AB1..AB9](../open-questions.md#agent-bootstrap-credentials-issue-27-2026-10-30)); nothing is decided until the maintainer resolves it there.
Date: 2026-10-30
Issue: [#27](https://github.com/Supportseal/SupportSeal-app/issues/27)

## Context

[ADR-0005](0005-agent-first-workspace-api.md) lets a token holding `tokens:admin`
mint narrower tokens, but fixes the *first* credential: it is "minted in the
dashboard (or by hosted signup, FR-API-15)" (AA1, FR-API-01), and the API never
grants `tokens:admin` (AA9). There is no CLI (ADR-0005). This ADR does not
reopen any of that. It asks only what, if anything, may sit in front of the
dashboard step so that an outside agent can onboard a **self-hosted** instance
without a human copy-pasting a secret into a chat.

Today on a self-hosted install an agent can do none of it over HTTP: the first
account registers at `/register` (first account becomes Admin; registration
then closes, `createWorkspace` under an advisory lock), the Workspace is made
in `/onboarding`, and the token is made by a server action. All three need a
browser session.

## Threat model

- The first credential is the root of a tenant. Whoever obtains it owns the
  Workspace, so the proof of "who may obtain it" is the whole design.
- Self-hosted already trusts the first party to reach `/register` before an
  attacker does ("create that account before you expose port 3000",
  self-hosting.md). Anyone who can set the app's environment can already read
  the database and every secret, so *control of the deployment environment* is
  a valid proof for the operator, and no stronger than what they hold anyway.
- Hosted must not gain an unauthenticated token-minting path. FR-API-15
  (signup, restricted token, human gates) remains the only hosted route.
- Mutating bootstrap endpoints are unauthenticated by nature, so they are
  abuse targets: guessing, replay, table-filling, phishing the approver.
- Tenant comes from the proof, never from a request field (ADR-0005 rule 2).

## Proposal

Two mechanisms, independent, either can be rejected. Neither adds a CLI or a
second auth scheme; both end in an ordinary `ss_live_` token validated by the
existing path.

**Transport.** Both flows carry credentials in request and response bodies, so
they are HTTPS-only. The routes reject plaintext requests (`403`, no
credential processing) when the request is not secure, judged from the request
origin (`x-forwarded-proto`, as the widget code reads it). That header is
only trustworthy when the first trusted proxy overwrites it and the app
listener is not reachable except through that proxy; a client that can reach
the listener directly can forge `X-Forwarded-Proto: https`. The self-hosting
guide therefore requires a TLS-terminating proxy that sets the header and a
listener bound to the proxy only before either flow is enabled; where that
cannot be assured, the flows stay disabled (recorded in AB1 as a precondition
of adopting either mechanism). The one exemption is a loopback request
(`localhost`, `127.0.0.1`, `::1`) with no forwarded headers, so local
development and the plain-HTTP E2E servers keep working; the guide's current
"no proxy" mode (port 3000 published directly) does not qualify and does not get
these flows. Responses carry `Cache-Control: private, no-store`.

**Error shape.** Every response, success or failure, uses the shared envelope
`{ "error": { "code", "message" } }` from `src/lib/api-errors.ts`. The device
poll states (`authorization_pending`, `slow_down`, `access_denied`,
`expired_token`) become additional stable `code` values in that table (`400`),
not RFC 8628's bare `{ "error": "..." }` body, so a client has one error parser.

### A. Setup secret: headless first run (self-hosted only)

1. The operator (or the agent that writes the compose `.env`) sets
   `SETUP_TOKEN` to a random value of at least 32 characters and
   `SETUP_ADMIN_EMAIL` to the human Admin's address. Shorter values
   make the server refuse to enable the endpoint and log why.
2. `POST /api/v1/bootstrap` with `Authorization: Bearer <setup secret>` and
   `{ workspaceName }` creates the single Workspace and returns
   `{ workspaceId, token, expiresAt, scopes }`. A separate high-entropy
   one-time `claimCode` (hashed at rest, not the setup secret) lets a human
   become the Admin (AB3). It is **not** in the response: the agent holds the
   token, and giving it the claim code too would let it register the first
   Admin itself. The Admin address is operator configuration
   (`SETUP_ADMIN_EMAIL`), never request input, because a caller-chosen address
   would only prove control of the agent's mailbox. The code goes to that
   address through the outbound email adapter, and `/register` accepts it only
   for that same address, so the human-only proof is control of the operator's
   mailbox. If the agent wrote the whole `.env` it also chose that address;
   that is the trust the operator already extended by letting it deploy.
3. It works exactly once: the check "no Workspace exists", the Workspace
   create, the token insert and the claim-code insert run in the **same**
   advisory-lock transaction `createWorkspace` already uses, so there is never
   a Workspace without a token, or a token without its Workspace. After the
   first Workspace exists the route answers like an unknown route (`404`), with
   or without the secret, so it cannot be probed for state.
   *Lost response.* The server cannot tell whether the client received the one
   response, and the token is not recoverable. The `claimCode` is unaffected
   (it was emailed), so the human claims the Admin at `/register` and mints a
   fresh dashboard token; the orphaned bootstrap token expires on its own or is
   revoked there. Only when no outbound email is configured (the AB3 log
   alternative) does the operator have to recreate the still-empty database. A
   bounded re-issue window authenticated by the same secret is the alternative
   (AB6); the recommendation is not to build it.
4. The secret is compared as `timingSafeEqual` of SHA-256 digests. It is never
   logged, echoed, or stored in the database. Failed attempts count against the
   existing per-IP failed-auth bucket and a tighter dedicated one.
5. The response token is a *setup* token: no `tokens:admin`, no
   `conversations:reply`, no `webhooks:*`, no `team:write`; short required
   expiry. A human (or an agent holding a dashboard-minted `tokens:admin`
   token) issues anything longer-lived in the dashboard, as ADR-0005 already
   specifies.
6. Hosted: the route does not exist when `HOSTED_MODE=1`. It is decided by
   `isHostedMode()` alone, never by whether `SETUP_TOKEN` is set, so a hosted
   misconfiguration cannot turn it on.

Unresolved inside A: who the Admin user is and how it is claimed (AB3),
whether a configured secret also gates `/register` (AB5), and the lost-response
recovery window (AB6).

### B. Device-code approval (existing Workspace, both modes)

RFC 8628 shape, for when the agent did not deploy the instance and a human
Admin already exists:

1. `POST /api/v1/device/authorize { label, scopes }` (unauthenticated, rate
   limited, bounded pending rows) returns a high-entropy `deviceCode` (hashed
   at rest) and a short `userCode`, 10 minute expiry, 5 second poll interval.
2. A signed-in Admin opens a dashboard page, sees the label, requester IP and
   requested scopes, picks the scopes (subset of what was requested) and an
   expiry, and approves or denies. The Workspace is the approver's session
   Workspace; nothing in the agent's request names one.
3. `POST /api/v1/device/token { deviceCode }` answers `authorization_pending`,
   `slow_down`, `access_denied`, `expired_token`, or the token.
   *Atomic claim.* Approval stores only the approved scopes and expiry, not a
   token. The first poll to flip `deliveredAt` from null in a conditional
   update (`... WHERE deliveredAt IS NULL`) wins; in that same transaction it
   mints the token and stores its hash with the approved scopes and expiry, and
   only that response carries the plaintext. Concurrent polls lose and answer
   like an unknown code, so a token is never issued twice.
   *Lost response.* The plaintext is not stored recoverably, so a lost
   response is not replayable. The agent restarts the flow and the approver
   revokes the orphaned token from the dashboard (its approval shows as
   delivered but unused). Re-delivering the same token for a bounded window to
   the same `deviceCode` would need the plaintext at rest and is rejected.
4. It cannot create a tenant, so it adds no hosted signup path. Its extra
   abuse surface is unauthenticated pending requests (table-filling) and
   approver phishing (an attacker shows a victim Admin a code); see AB7.

## Why this shape

- **Smallest human step, no secret in transit through a human.** A removes the
  human for the operator case; B replaces "copy a token into the chat" with a
  one-click approval.
- **No new privilege.** Neither mints `tokens:admin` (AA9), so a leaked
  bootstrap or device token cannot clone itself.
- **Isolation is structural.** The Workspace comes from the deployment (A:
  there is only one) or the approving session (B), never from input.

## Alternatives considered

- **Status quo, dashboard only.** Safe, already decided; leaves the issue open.
- **A one-time secret printed to the server log or a file on first boot**
  (Jenkins style): no configuration needed, but log shippers and shared
  volumes copy it; proof becomes "can read logs". Kept as AB2 option.
- **A CLI or first-run wizard command.** Rejected by ADR-0005.
- **Hosted: allow B unauthenticated-with-email or open `/bootstrap`.**
  Rejected; hosted onboarding is FR-API-15 only.

## Dependencies

Slice 1a (scope registry, `v1Route`) is merged. This work also needs the audit
log and token-creation core (slices 1b/1e), the `tokens:admin` scope in the
registry (already listed), and, for A, the ownerless-Workspace spike already
required by FR-API-15 unless AB3 chooses the smaller option. No code is
proposed before AB1..AB3 are answered.

## Required tests for the implementing slice

Alpha/Beta fixture (FR-SEC-01) plus the following abuse cases. Wherever the
text says "answers like an unknown route/code", the status and body match the
unknown-route or invalid-credential baseline (the same envelope code and
message) and carry no state-dependent header:

- A: replay (second use after success), wrong secret, short secret refused,
  concurrent double claim (exactly one wins), route absent in hosted mode even
  with the secret set, route `404` once a Workspace exists, secret never in
  logs or responses, rate limit `429` with `Retry-After`, constant-time
  compare, the returned token cannot reach another Workspace and lacks the
  excluded scopes, expiry honoured, Workspace and token are created atomically
  (a failure after the Workspace insert leaves neither), the claim code is
  never in any bootstrap response or log, the bootstrap caller alone cannot
  complete the Admin claim, registering with a different email than
  `SETUP_ADMIN_EMAIL` is refused, a request body naming an email is ignored, the claim code is single-use, expires, and exactly one concurrent claim wins; an expired,
  unclaimed `claimCode` leaves the Workspace unclaimable and the documented
  recovery applies, plaintext HTTP refused
  without processing the credential.
- B: replay of a consumed or expired `deviceCode`, poll faster than the
  interval (`slow_down`), user-code guessing limited per code and per IP,
  approver in Workspace B cannot complete or read a request approved in
  Workspace A, agent-requested scopes never exceed approved scopes, the token
  is delivered once even under concurrent polls, plaintext HTTP refused, pending-row cap and expiry purge, `tokens:admin` never
  grantable.
- Audit rows for each success, denial and rate-limited attempt, bounded per
  the plan's denied-attempt rule.

## Consequences

If accepted, FR-API-01's sentence "dashboard sessions remain the way to mint
the first token" is amended to name these two paths for self-hosted
installations, and [agent-api-plan.md](../agent-api-plan.md) gains a phase 3
slice. Until then this ADR changes nothing.
