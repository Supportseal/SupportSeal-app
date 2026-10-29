# API tokens

API tokens let scripts, CI and agents call the Workspace API without a
dashboard login or a session cookie. A token acts for its **whole Workspace**,
never as a person, and it can never see another Workspace. Tokens work the same
on the hosted tier and on a self-hosted installation, and need no external
service.

Only Workspace **admins** can create, see and revoke tokens. Other members do
not see the **API tokens** tab.

## Create a token

1. Sign in as an admin and open **Settings → API tokens**.
2. Under **Create a token**, enter a **Name** that says what uses it (for
   example `Provisioning script`). Optionally set an **Expires** date; the token
   stops working at the end of that day (UTC).
3. Choose **Create token**, then **Copy token**.

The full token is shown **once**. SupportSeal stores only a SHA-256 hash, so it
cannot show the token again; if you lose it, revoke it and create another. The
list afterwards shows each token's name, its last four characters, when it was
created and last used, its expiry, and whether it is revoked.

A token looks like `ss_live_` followed by 43 random characters. The fixed
prefix lets secret scanners find leaked tokens. Keep tokens out of source
control and client-side code.

## Revoke a token

Choose **Revoke** next to the token. It stops working immediately, and the row
stays in the list as **revoked**. Revoking twice is harmless. Remove a token
you no longer trust, and rotate by creating the new one before revoking the
old one.

## Use a token

Send it as a Bearer token:

```sh
curl -H "Authorization: Bearer ss_live_..." https://dashboard.example.com/api/products
curl -H "Authorization: Bearer ss_live_..." https://dashboard.example.com/api/products/PRODUCT_ID
```

Each Product comes back with its `widgetKey` (public, for the chat snippet) and
its `formKey` (`fk_…`, for a server-side contact form; keep it out of page HTML).
Replace `dashboard.example.com` with your installation's public URL (the hosted
tier is `https://dashboard.supportseal.app`). To create and edit Products, follow
the [API quickstart](api-quickstart.md); the contract is [openapi.json](openapi.json).

A request that sends an `Authorization` header is judged on the token alone; a
browser session cookie is not used as a fallback. **Writes (`POST`, `PATCH`)
accept tokens only**, never a session cookie.

## Scopes

| Scope | Grants |
| --- | --- |
| `products:write` | Read Products (`GET /api/products`, `GET /api/products/[id]`) and create or edit them (`POST /api/products`, `PATCH /api/products/[id]`, including their domains). |

Every token created in the dashboard has the `products:write` scope; it acts for
the whole Workspace and cannot reach another one. A token without the scope an
endpoint needs gets `403 insufficient_scope`.

> **Planned, not yet available:** finer scopes (conversations, contacts, webhooks and others) and a `tokens:admin` scope that lets a token create and revoke other tokens through the API. Until it ships, tokens are created in the dashboard only. See the [agent-first API plan](agent-api-plan.md).

## Errors

Every error from the Workspace API, for tokens and sessions alike, has one JSON
shape:

```json
{ "error": { "code": "invalid_request", "message": "The request body is invalid.",
             "details": [{ "field": "name", "message": "Product name must be between 1 and 60 characters." }] } }
```

`code` is stable and meant for programs; `message` is for people and may change;
`details` (field-level, naming the offending field) appears only on `invalid_request` and on a `conflict`
that names a field. Responses are `private, no-store`.

| Status | `code` | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | The body is not valid JSON, is too large (64 KiB), has an unknown field, a domain list longer than 100 entries, a value fails validation, or a `PATCH` changes nothing (none of `name`, `primaryColor`, a non-empty `addDomains` or a non-empty `removeDomains`). `details` names the offending field. |
| `401` | `unauthorized` | The token is missing the `Bearer` scheme, malformed, unknown, revoked or expired, or a write came without a token. All token failures look identical on purpose. Carries `WWW-Authenticate: Bearer`. |
| `403` | `insufficient_scope` | The token is valid but lacks the scope the endpoint needs. |
| `403` | `forbidden` | A signed-in session that is not a Workspace admin (reads only). |
| `404` | `not_found` | The id does not exist **or belongs to another Workspace**; the two cannot be told apart. |
| `409` | `conflict` | The request clashes with current state: adding a domain the Product already has, or removing one it does not have. Nothing is applied. |
| `409` | `product_limit_reached` | `POST /api/products` only: the Workspace already has 100 Products (archived ones count), the most the API will create. Nothing is created. This is an abuse guard for leaked tokens, applied the same way on self-hosted deployments; the dashboard has no such cap, so create further Products there. |
| `429` | `rate_limited` | Too many failed token attempts from this IP in the last minute, or more than 30 writes per minute with this token. `Retry-After` gives the seconds to wait. |
| `500` | `internal_error` | The server could not complete the request (an unexpected failure, or no free inbound address); the message is generic and the detail is only in the server log. Retry. |

`409 conflict` detection is best-effort under concurrent requests: two simultaneous
`PATCH`es adding the same domain can both succeed, and the data stays consistent
(a domain is stored once per Product). `PATCH` is safe to retry.

Status `405` (a method the route does not have) comes from the framework and has
no JSON body.
