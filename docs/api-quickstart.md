# API quickstart: create a Product and install the widget

Create a Product, allow its domains and read its **widget key** and **form key**
with plain HTTP, without opening the dashboard. This works the same on the hosted tier and on a
self-hosted installation; only the base URL changes. It needs no Stripe, hosted
API or other external service.

The full machine-readable contract is [openapi.json](openapi.json) (OpenAPI
3.1). The live spec for your installation is `$SUPPORTSEAL_URL/api/openapi.json`
(public, no token needed; its server default is already your installation's
address). Other guides: [api-tokens.md](api-tokens.md) (token lifecycle and error
reference), [widget-integration.md](widget-integration.md) (the snippet in
depth), [add-product.md](add-product.md) (the dashboard path, plus email setup).

You need `curl` 7.76 or newer (for `--fail-with-body`), [`jq`](https://jqlang.github.io/jq/)
(it only saves you copying ids by hand), and a Workspace **admin** account to
create the token.

## 0. Set your variables

```sh
# Hosted tier:
export SUPPORTSEAL_URL=https://dashboard.supportseal.app
# Self-hosted: your installation's public URL (its NEXT_PUBLIC_APP_URL). No trailing slash:
# "$SUPPORTSEAL_URL//api/products" answers a 308 redirect that curl does not follow without -L.
# export SUPPORTSEAL_URL=https://support.example.com

export SUPPORTSEAL_TOKEN=ss_live_...   # created in step 1
```

Check the URL before you go further. The live spec needs no token:

```sh
curl --fail-with-body -sS "$SUPPORTSEAL_URL/api/openapi.json" | jq -e '.info.title, .servers[0].variables.baseUrl.default'
```

It prints `"SupportSeal Workspace API"` and your own base URL.

## 1. Create an API token (a human does this, in the dashboard)

1. Sign in as a Workspace admin and open **Settings → API tokens**.
2. Enter a **Name** (for example `Provisioning script`), optionally an
   **Expires** date, and choose **Create token**.
3. Copy the token (`ss_live_…`) now. It is shown **once**; only its hash is
   stored, so a lost token cannot be recovered. Revoke it and create another.

Tokens **cannot be created through the API**, on purpose. Minting a token needs
a signed-in human admin; if a token could mint tokens, one leaked token would
let an attacker create copies that survive its revocation. Likewise, writes
never accept a browser session cookie, only a token. A token acts for the whole
Workspace and can never see another one. Details: [api-tokens.md](api-tokens.md).

Check that the token works. It lists the Workspace's Products (`{"products":[]}`
while there are none):

```sh
curl -sS "$SUPPORTSEAL_URL/api/products" -H "Authorization: Bearer $SUPPORTSEAL_TOKEN"
```

```json
{ "products": [] }
```

To see which Workspace the token acts in and which scopes it holds, ask
`/api/v1/whoami`. Any valid token may call it:

```sh
curl -sS "$SUPPORTSEAL_URL/api/v1/whoami" -H "Authorization: Bearer $SUPPORTSEAL_TOKEN"
```

```json
{
  "workspace": { "id": "9b2d4c1e-7a3f-4e8b-9c1d-2f6a8e0b4d17", "name": "Acme Support" },
  "token": { "id": "c4e8a2f0-1b3d-4f5a-8e7c-6d9b0a2e4f81", "name": "Provisioning script", "scopes": ["products:write"], "expiresAt": null }
}
```

The `/api/v1` endpoints accept only the `Authorization` header, never a
dashboard session cookie.

## 2. Create the Product

Only `name` is required. `primaryColor` defaults to `#2563eb` and accepts `#rgb`
or `#rrggbb`. `supportEmail` is the public address your customers write to, with
the dashboard's rules: trimmed, lower-cased, never the Product's generated
forwarding address. Blank or `null` stores none; send `{"supportEmail":null}` in a
`PATCH` later to remove it.

```sh
curl --fail-with-body -sS -X POST "$SUPPORTSEAL_URL/api/products" \
  -H "Authorization: Bearer $SUPPORTSEAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme App","primaryColor":"#7367f0"}' -o product.json; cat product.json
export PRODUCT_ID=$(jq -r '.id // empty' product.json)
: "${PRODUCT_ID:?Product was not created; see the error above}"
```

`--fail-with-body` makes curl exit non-zero on any `4xx`/`5xx` and still save the
error body. If `product.json` holds an error instead of a Product, `PRODUCT_ID`
is empty and the second line stops with a message (in a script with `set -e` it
aborts the script): fix the request using the [error table](#errors) before going
on.

`201 Created`, with a `Location: /api/products/<id>` header and the Product:

```json
{
  "id": "3f6c0a52-0b1e-4c52-9d1c-5f0e7a8f1c11",
  "name": "Acme App",
  "archived": false,
  "primaryColor": "#7367f0",
  "supportEmail": null,
  "domains": [],
  "widgetKey": "pk_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  "formKey": "fk_ZyXwVuTsRqPoNmLkJiHgFeDcBa987654"
}
```

You can also pass `domains` here (hostnames or URLs, reduced to the hostname)
and `includeSiblings: true`; step 3 does the same on an existing Product. Each
domain list takes at most 100 entries.

## 3. Allow the site's domains

The widget loads only on allowed hostnames. `PATCH` **edits**: `addDomains` adds,
`removeDomains` removes, omitted fields stay as they are, and all changes in one
request apply together or not at all. `includeSiblings: true` also allows the
apex/`www.` counterpart of each added domain, like the dashboard's checkbox.

```sh
curl --fail-with-body -sS -X PATCH "$SUPPORTSEAL_URL/api/products/$PRODUCT_ID" \
  -H "Authorization: Bearer $SUPPORTSEAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"addDomains":["acme.example"],"includeSiblings":true}'
```

`200 OK` returns the whole Product:

```json
{
  "id": "3f6c0a52-0b1e-4c52-9d1c-5f0e7a8f1c11",
  "name": "Acme App",
  "archived": false,
  "primaryColor": "#7367f0",
  "supportEmail": null,
  "domains": ["acme.example", "www.acme.example"],
  "widgetKey": "pk_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  "formKey": "fk_ZyXwVuTsRqPoNmLkJiHgFeDcBa987654"
}
```

Entries match the **exact hostname**: `acme.example` does not cover
`www.acme.example` (hence `includeSiblings`), and `*.acme.example` covers
subdomains but not `acme.example`. `localhost` works without being listed only
while the server runs in development (`next dev`); a production build (Docker,
`npm run start`) needs `"addDomains":["localhost"]` first.

To replace one hostname with another, send both in one request, for example
`{"addDomains":["app.acme.example"],"removeDomains":["www.acme.example"]}`. The
same hostname in both lists is a `400 invalid_request` (`"x" cannot be both added and
removed.`, field `removeDomains`); to remove and re-add a hostname, make two
calls. A request that changes nothing (an empty body, only empty lists, or
`includeSiblings` alone) is also rejected with `400 invalid_request`.

## 4. Read the keys

Every Product has two keys, both in the responses above. To read them later,
from any machine with a token:

```sh
curl --fail-with-body -sS "$SUPPORTSEAL_URL/api/products/$PRODUCT_ID" \
  -H "Authorization: Bearer $SUPPORTSEAL_TOKEN" -o product.json; cat product.json
export WIDGET_KEY=$(jq -r '.widgetKey // empty' product.json)
export FORM_KEY=$(jq -r '.formKey // empty' product.json)
: "${WIDGET_KEY:?No widget key; see the error above}"
```

`GET /api/products` lists every Product with its keys.

| Key | Field | Used for | Where it lives |
| --- | --- | --- | --- |
| **Widget key** (`pk_…`) | `widgetKey` | The chat widget's `data-key` (step 5). | In your page source. It is public and grants no access to conversations or Workspace data. |
| **Form key** (`fk_…`) | `formKey` | Your own contact form: a server-side handler posts a visitor's message to `POST /api/widget/form` with the key in an `x-ss-form-key` header and gets a Conversation (see below). | On your server only, never in page HTML. Possession authorises posting, so anyone who has it can create Conversations; rotate it in the dashboard if it leaks. |

Treat the **token** as the secret, not the widget key. An archived Product still
appears in `GET` responses with `"archived": true`, but its keys stop working
(the widget probe below answers `404`, and form posts are rejected).

`formKey` is `null` for a Product created before form keys existed. Products
created through the API always have one. A missing key can only be generated by a
Workspace admin in the dashboard (Product **Developer** tab), not through the API.

To use the form key (skip this if you only want the widget), post from your
server. `email` and `message` are required; `name` and `subject` are optional:

```sh
curl --fail-with-body -sS -X POST "$SUPPORTSEAL_URL/api/widget/form" \
  -H "content-type: application/json" -H "x-ss-form-key: $FORM_KEY" \
  -d '{"email":"visitor@example.com","name":"Sam","subject":"Login issue","message":"I cannot log in since yesterday."}'
```

The response carries the Conversation's `ticketRef` for your confirmation
screen. This endpoint predates the Workspace API and has its own, simpler error
shape (an unknown, rotated or archived-Product key answers `404`). On the
hosted Free plan, once a Workspace's 7-day grace period after going over its
monthly allowance ends, the form answers `402` with
`{"error":"service_paused","message":"…"}` until the Workspace upgrades; show the `message` to your visitor. Self-hosted installs
never return it.

## 5. Embed the widget and check the allowlist

The snippets below use two placeholders: `WIDGET_SERVER_URL` is your
`$SUPPORTSEAL_URL` (the widget server, never your own site's URL) and `WIDGET_KEY` is
the `widgetKey` from step 4. This prints the plain tag with both filled in from
your environment, so a self-hosted install cannot ship the hosted URL by mistake:

```sh
printf '<script async src="%s/widget.js" data-key="%s"></script>\n' "$SUPPORTSEAL_URL" "$WIDGET_KEY"
```

Plain HTML, just before `</body>` on each page:

```html
<script
  async
  src="WIDGET_SERVER_URL/widget.js"
  data-key="WIDGET_KEY"
></script>
```

Next.js (App Router), rendered once in the root layout:

```jsx
"use client";

import Script from "next/script";

export default function SupportWidget() {
  return (
    <Script
      id="support-widget-script"
      src="WIDGET_SERVER_URL/widget.js"
      data-key="WIDGET_KEY"
    />
  );
}
```

For plain React, identifying signed-in users, and one codebase serving several
sites, see [widget-integration.md](widget-integration.md).

Prove the allowlist before you deploy. The widget boots by calling this public
endpoint, so a `200` here means the widget will load on that hostname:

```sh
curl -fsS "$SUPPORTSEAL_URL/api/widget/config?key=$WIDGET_KEY&host=www.acme.example"
curl -sS  "$SUPPORTSEAL_URL/api/widget/config?key=$WIDGET_KEY&host=other.example.net"
```

```json
{ "name": "Acme App", "color": "#7367f0", "availability": "LIVE" }
```

The probe has three outcomes (this public endpoint predates the Workspace API and
has its own, simpler error shape):

| Response | Meaning | Fix |
| --- | --- | --- |
| `200` with the Product's public configuration | The hostname is allowed; the widget will load. (`availability` depends on your Workspace.) | None. |
| `403 {"error":"origin_not_allowed"}` | The key is valid but the hostname is not on the allowlist. | Add the exact hostname with `addDomains` (step 3). |
| `404 {"error":"not_found"}` | The key is unknown, does not start with `pk_`, is unset (`$WIDGET_KEY` empty), or belongs to an **archived** Product. | Re-read the key (step 4); check `archived` in the `GET` response. |

Probe `acme.example` and `www.acme.example` separately: they are distinct entries.

## 6. Reply to a conversation

A token with `conversations:reply` can answer a customer, and one with
`conversations:write` can add a note or change status and tags. Set
`CONVERSATION_ID` to the Conversation's id. Sending a reply needs an
`Idempotency-Key` (1-128 characters of `A-Za-z0-9_-`), so a retry after a
timeout cannot email the customer twice:

```sh
curl -sS -X POST "$SUPPORTSEAL_URL/api/v1/conversations/$CONVERSATION_ID/messages" -H "Authorization: Bearer $SUPPORTSEAL_TOKEN" -H "Idempotency-Key: reply-2026-10-31-001" -H "Content-Type: application/json" -d '{"kind":"reply","body":"Thanks for reaching out. The fix is live; please refresh and tell us if it persists."}'
```

The `201` response shows how the reply travelled. `delivery.state` is `sent`
(emailed), `not_applicable` (a chat-only reply, or a note) or `failed` (the
email could not be sent; the reply is stored and the failure is recorded in the
dashboard):

```json
{
  "id": "5d1f7c3a-92b4-4e6d-8a10-3b7c9e2f4a68",
  "conversationId": "e0a4b6c8-1d2f-4a35-9c7e-8b1d3f5a7c92",
  "kind": "reply",
  "body": "Thanks for reaching out. The fix is live; please refresh and tell us if it persists.",
  "author": { "type": "token", "id": "c4e8a2f0-1b3d-4f5a-8e7c-6d9b0a2e4f81", "name": "Support agent" },
  "attachments": [],
  "delivery": { "state": "sent" },
  "createdAt": "2026-10-31T04:12:09.000Z"
}
```

Sending the same key and body again returns the stored response with
`Idempotent-Replayed: true`; the same key with a different body is
`409 idempotency_conflict`. A reply to a Closed Conversation reopens it, and
replies answer `402 service_paused` while a Free-plan Workspace is paused and
`409 conflict` when the Conversation's Product is archived (notes still work). The inbox shows the reply as `Support agent (API)`.

Close a Conversation and tag it in one call; either both changes apply or
neither does:

```sh
curl -sS -X PATCH "$SUPPORTSEAL_URL/api/v1/conversations/$CONVERSATION_ID" -H "Authorization: Bearer $SUPPORTSEAL_TOKEN" -H "Content-Type: application/json" -d '{"status":"CLOSED","addTags":["billing"]}'
```

## Errors

Every failure from the API has one JSON shape. Branch on `code`, never on
`message`:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Product name must be between 1 and 60 characters.",
    "details": [{ "field": "name", "message": "Product name must be between 1 and 60 characters." }]
  }
}
```

| Status | `code` | Meaning | Fix |
| --- | --- | --- | --- |
| 400 | `invalid_request` | Body is not JSON, is over 64 KiB, has an unknown field, a domain list longer than 100 entries, a bad value, the same domain in `addDomains` and `removeDomains`, or (`PATCH`) changes nothing. `details[].field` names the field when one is at fault (not for invalid JSON or an oversized body). | Fix the named field and resend. |
| 401 | `unauthorized` | Token missing, malformed, unknown, revoked or expired (all look identical), or a write came without a token. Carries `WWW-Authenticate: Bearer` (except for a cookie read that is not signed in). | Send `Authorization: Bearer $SUPPORTSEAL_TOKEN`; if it was revoked or expired, create a new token (step 1). |
| 403 | `insufficient_scope` | The token lacks the scope the call needs (`products:write` for Products, `conversations:reply` for replies, `conversations:write` for notes, status and tags). Tokens created in the dashboard carry all three, so seeing this means a token created before the conversation scopes existed, or a modified deployment. | Create a fresh token in **Settings → API tokens** and use that. |
| 403 | `forbidden` | A signed-in session that is not a Workspace admin (reads with a cookie only). | Use an admin account, or a token. |
| 402 | `service_paused` | `POST …/messages` with `kind: "reply"` while a Free-plan Workspace has used its monthly allowance. Nothing was stored. Notes keep working. | Show the `message` to your user; the Workspace must upgrade or wait for the next period. |
| 404 | `not_found` | The id does not exist or belongs to another Workspace (indistinguishable). | Check the id and that the token belongs to the right Workspace. |
| 409 | `conflict` | `addDomains` names a domain already allowed, or `removeDomains` one that is not; or `POST …/messages` with `kind: "reply"` for a Conversation whose Product is archived (the reply would bounce). Nothing was applied or stored. The check is best-effort under concurrent requests (see below). | Drop the entry or `GET` the Product to see its current domains. |
| 409 | `product_limit_reached` | `POST /api/products` when the Workspace already has 100 Products (archived ones count). Nothing was created. | Retrying will not help. Archive-and-recreate does not help either; create further Products in the dashboard, which has no cap. |
| 409 | `idempotency_conflict` | The `Idempotency-Key` was already used with a different body, method or path. | Use a new key for a new request; resend the identical request to get the stored answer. |
| 409 | `idempotency_in_flight` | A request with the same key is still running. Carries `Retry-After`. | Wait `Retry-After` seconds and send the same request again. |
| 429 | `rate_limited` | 20 failed token attempts from your IP in a minute, more than 30 writes per minute with this token, or on `/api/v1` more than 120 reads per minute with this token or 300 requests per minute from your IP. | Wait `Retry-After` seconds (60), then retry. |
| 500 | `internal_error` | The server could not complete the request (an unexpected failure; the message is generic and the detail is only in the server log). Any endpoint can return it. | Retry with backoff; check the server logs if it persists. |

A method a route does not have returns `405` from the framework with no JSON
body.

## Retries, idempotency and limits

- **`PATCH` is safe to retry** after a timeout. If the first attempt succeeded,
  the retry returns `409 conflict` for a domain that is now present (or absent):
  that means the change is already in place. `GET` the Product to confirm. The
  `409` check is best-effort under concurrent requests: two simultaneous requests
  adding the same domain can both succeed, and the data stays consistent (a domain
  is stored once per Product).
- **Replies are idempotent when you send a key.** `POST …/messages` with `kind: "reply"` requires an
  `Idempotency-Key` (400 without one); notes and `PATCH /api/v1/conversations/{id}` accept one. A key is remembered
  for 24 hours. Replaying it with the same request returns the stored response plus `Idempotent-Replayed: true`
  and sends nothing again. Reuse a key only to retry the same request. Replies are limited to 20 per minute per token.
- **`POST /api/products` is not idempotent** and has no idempotency key. After a timeout, call
  `GET /api/products` and look for the name before posting again, or you create a
  duplicate.
- **A Workspace can hold at most 100 Products through the API** (`POST`
  answers `409 product_limit_reached` beyond that); the dashboard has no such cap.
  It is an abuse guard for leaked tokens, and the same on self-hosted deployments.
- Retry `429` (after `Retry-After`) and `5xx` with backoff. Do not retry other
  `4xx`; fix the request.
- **Limits:** 30 writes (`POST`/`PATCH`) per minute per token, and 20 failed
  token attempts per minute per client IP. On `/api/v1`, reads are also limited
  to 120 per minute per token, and all requests to 300 per minute per client IP.
  Successful reads of `/api/products` are not rate-limited.
  Limits are in-process, so a multi-process self-hosted deployment enforces them
  per process.
- Responses are `Cache-Control: private, no-store`.

## Using this from a coding agent

Give the agent these facts and nothing more; it needs no dashboard access once a
human has created the token.

- **Credential:** the token in the environment variable `SUPPORTSEAL_TOKEN`,
  the server in `SUPPORTSEAL_URL`. Never write the token into a file that is committed,
  a prompt, a log or client-side code; `ss_live_` is a fixed prefix so secret
  scanners can find leaks. If a token leaks, revoke it in **Settings → API
  tokens**.
- **Contract:** `GET $SUPPORTSEAL_URL/api/openapi.json` (no token needed, ETag-revalidated,
  CORS-open; the same file as [openapi.json](openapi.json) with the server
  default set to the address you called, so it works unchanged on any
  installation). Every request sends
  `Authorization: Bearer $SUPPORTSEAL_TOKEN`; bodies are JSON with
  `Content-Type: application/json`.
- **Flow:** `POST /api/products` (body `{"name": …}`), then
  `PATCH /api/products/{id}` with `{"addDomains": […], "includeSiblings": true}`,
  then `GET /api/products/{id}` to read `widgetKey` (and `formKey` for a contact
  form), then put the widget key in the snippet (step 5).
- **Success:** `POST` returns `201`, `PATCH` and `GET` return `200`, the body's
  `domains` array contains every hostname you sent, and
  `GET $SUPPORTSEAL_URL/api/widget/config?key=<widgetKey>&host=<hostname>` returns
  `200` for each hostname (`403` means that hostname is not allowed, `404` means
  the key is wrong or its Product is archived).
  Each probe also shows up under **Installation** on the Product's Widget tab
  (hostname and last-seen time only; refused hostnames get an **Allow** button),
  which is the quickest way to see what a deployed site is actually sending.
- **Failure:** branch on `error.code`. Stop and report on `unauthorized`,
  `insufficient_scope` and `forbidden`; do not retry them. Retry `rate_limited`
  after `Retry-After` and `internal_error` with backoff. On a timed-out `POST`,
  list Products before posting again.
- **Scope:** the token can create and edit Products in its own Workspace and
  nothing else. It cannot read conversations, customers or other tokens.

## Self-hosted notes

- A self-hosted installation serves exactly one Workspace, so a token always
  works on that Workspace's Products and there is nothing to select.
- `SUPPORTSEAL_URL` is the public origin you set as `NEXT_PUBLIC_APP_URL`; use it
  without a trailing slash. See [self-hosting.md](self-hosting.md).
- Run the server behind a reverse proxy: the failed-token limit keys on the
  client IP the proxy reports (the last `X-Forwarded-For` entry, or
  `TRUSTED_PROXY_HEADER` when set) and is skipped when none is available; see
  [self-hosting.md](self-hosting.md#trusted-client-ip-header-trusted_proxy_header).
