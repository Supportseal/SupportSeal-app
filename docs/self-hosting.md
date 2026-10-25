# Self-hosting SupportSeal

SupportSeal is designed to be genuinely pleasant to self-host: one app
container, one PostgreSQL database, no external service requirements. A
self-hosted installation serves **exactly one Workspace** with unlimited
Products and agents (ADR-0001) and never requires Stripe, the hosted API or
external telemetry (FR-HOST-01).

## Quick start

```bash
git clone https://github.com/pietervw/SupportSeal-app.git
cd supportseal
cp .env.example .env        # then edit (see the reference below)
docker compose up -d
```

`docker compose up` starts three services:

| Service  | What it does |
| -------- | ------------ |
| `db`     | PostgreSQL 17 with a persistent volume |
| `migrate`| One-shot `prisma migrate deploy` before the app boots |
| `app`    | The Next.js standalone build on port 3000 (health: `/api/health`) |

Open `http://<host>:3000`. On a fresh install the root page redirects to
`/register`; the first account becomes the Workspace Admin. Once the
Workspace exists, public registration closes automatically — further users
join by invitation from Settings → Team.

## Environment reference

Copy `.env.example` and fill in at least the required values:

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `DATABASE_URL` | yes | e.g. `postgresql://supportseal:pass@db:5432/supportseal`. If you point this at your own PostgreSQL instead of the compose `db` service, it must run with `timezone=UTC` (and a clock in sync with the app host) — the app logs a `[db-alignment]` error at boot otherwise, because message-stream cursors depend on it. |
| `BETTER_AUTH_SECRET` | yes | A random private server secret that signs login sessions **and** widget test-page links. Generate it with `openssl rand -base64 32`, then save the output as this environment variable. Never put it in browser code. |
| `NEXT_PUBLIC_APP_URL` | yes | Public origin, e.g. `https://support.example.com` (drives embed snippets, emails, auth). |
| `NEXT_PUBLIC_APP_NAME` | no | Brand name shown in the UI (defaults to SupportSeal). |
| `STORAGE_DIR` | no | Attachment storage directory (default `.dev-data/uploads`; mount a volume). |
| `INBOUND_WEBHOOK_SECRET` | for email | Shared secret for the inbound-mail webhook. Use a URL-safe value (`openssl rand -hex 32`) — the SendGrid Inbound Parse URL embeds it. |
| `INBOUND_EMAIL_DOMAIN` | for email | Domain that receives forwarded support mail, e.g. `inbound.example.com`. |
| `SENDGRID_API_KEY` | for email (either) | API key (Mail Send scope only) — outbound mail goes through the SendGrid API. One outbound provider (`SENDGRID_API_KEY` or `SMTP_URL`) is required to deliver replies; SendGrid takes precedence when both are set. |
| `SMTP_URL` | for email (either) | `smtps://user:pass@smtp.provider:465` — the SMTP alternative to `SENDGRID_API_KEY`. Without an outbound provider, replies are recorded but not delivered. |
| `OUTBOUND_EMAIL_LOCAL` | no | Local part of the managed sender (default `no-reply`). |
| `CRON_SECRET` | no | Enables `POST /api/internal/escalations/sweep` (Bearer auth) so a scheduler can trigger the unanswered-request alert sweep every minute. Alerts also fire from in-app activity and timers without it; see [design/escalation.md](design/escalation.md). |
| `HOSTED_MODE` | no | Leave unset for self-hosting. `1` enables multi-Workspace SaaS modules (billing). Never set this on a self-hosted install. |
| `TRUSTED_PROXY_HEADER` | no | Header your proxy sets with the real client IP (e.g. `cf-connecting-ip`), used by the per-IP rate limits instead of `X-Forwarded-For`. See [HTTPS / reverse proxy](#https--reverse-proxy) for the precondition. |

Stripe variables are hosted-mode only and are never needed here.

## Email setup

1. In the app: Settings → Products → your Product → Email shows the
   generated inbound address (`product_xxx@your-inbound-domain`).
2. Forward `support@yourproduct.com` to that address with your mail provider.
3. Point your provider's webhook/forwarder at
   `https://<your-host>/api/email/inbound` with the header
   `x-supportseal-inbound-secret: <INBOUND_WEBHOOK_SECRET>` (or embed
   `?secret=` in the destination URL if headers are unavailable).
4. Configure an outbound provider — `SMTP_URL` or a SendGrid API key
   (see [SendGrid](#sendgrid-hosted-provider-adr-0004)) — so agent replies
   are delivered from `"{Product} Support" <no-reply@…>` with a reply-to
   that threads back into the same conversation.

### Custom inbound mail domain (optional)

Besides forwarding, a Product can own a mail domain (Settings → Products →
Email, or the optional Mail step in onboarding): the customer points MX of a
dedicated (sub)domain at your mail host and publishes a TXT ownership token,
and **Verify** checks both with plain DNS lookups from the app server. Mail to
any address at a verified domain lands in that Product's inbox. Set
`INBOUND_MX_HOSTS` to the host(s) your inbound provider/bridge listens on (if
unset the live MX records of `INBOUND_EMAIL_DOMAIN` are used). Your mail
provider must also accept the domain — e.g. add it as an Inbound Parse
hostname; verification proves the customer's DNS, not your provider config.

### Advanced: support address and mail loops (optional)

Nothing here needs configuring. Optionally set a Product's **Support address**
(Settings → Products → Email), the address customers write to. It is shown in
the chat widget and used only as a guard: SupportSeal never sends mail to it,
to the generated forwarding address or to its own sender, stamps every mail it
sends with `X-SupportSeal`, and ignores inbound mail that is an auto-response
(`Auto-Submitted`, `Precedence: bulk|auto_reply`), carries that stamp, reuses
a Message-ID it issued, or comes from one of those addresses. Ignored mail is
listed in the delivery log with the reason. If your own mail system
auto-replies to everything, turning that off for the forwarded mailbox is
optional. If a relay strips unknown `X-` headers from your outbound mail, the
Message-ID and sender checks still apply.

### SendGrid (hosted provider, ADR-0004)

SendGrid replaces steps 3 and 4 (webhook + outbound); mail to
`support@yourproduct.com` still needs step 2's forwarding to your Product's
inbound address (or point your product domain's MX at `mx.sendgrid.net` and
use it as `INBOUND_EMAIL_DOMAIN`):

- **Inbound**: add an Inbound Parse hostname in SendGrid — it must be the
  same domain as `INBOUND_EMAIL_DOMAIN` — and create the MX record SendGrid
  shows you. Then set the destination URL to
  `https://<your-host>/api/email/inbound?secret=<INBOUND_WEBHOOK_SECRET>`
  (or embed the secret as Basic-auth userinfo,
  `https://<any>:<INBOUND_WEBHOOK_SECRET>@<your-host>/api/email/inbound`).
  Use a URL-safe secret (`openssl rand -hex 32`) or percent-encode it.
  SendGrid can sign Inbound Parse posts (ECDSA or OAuth), but SupportSeal does
  not verify those signatures yet, so the shared secret in the URL is the
  only protection: keep it out of proxy and access logs. SendGrid retries failed posts for up to 72 hours;
  processing is idempotent by Message-ID, so retries never duplicate a
  conversation.
- **Outbound**: set `SENDGRID_API_KEY` (Mail Send scope only).
  Sends go through the SendGrid v3 mail API from the same managed sender —
  authenticate the sending domain (or verify the `no-reply@…` /
  `OUTBOUND_EMAIL_LOCAL` address as a single sender) in SendGrid. When both
  `SENDGRID_API_KEY` and `SMTP_URL` are set, SendGrid wins.

## HTTPS / reverse proxy

Terminate TLS in front of the app (Caddy, Traefik, nginx). Three requirements:

- **SSE must not be buffered** — the app already sends
  `X-Accel-Buffering: no`, which measured sufficient through a stock
  nginx config (no extra directives required); `proxy_buffering off;`
  and a raised `proxy_read_timeout` for `/api/` are harmless extra
  headroom.
- **Never gzip `text/event-stream`** — compressing the event stream at
  the proxy holds messages back even when buffering is disabled
  (measured in the ADR-0003 spike). Exclude `text/event-stream` from
  `gzip_types` (nginx) or the `encode` matcher (Caddy). The app's 15 s
  heartbeats keep idle streams alive past default 60 s proxy read
  timeouts on their own.
- Preserve the `Host` header and pass `X-Forwarded-For` (used by the
  widget's per-IP rate limiter, which also caps how many anonymous chat
  sessions one IP may start per minute). See
  [Trusted client-IP header](#trusted-client-ip-header-trusted_proxy_header).

### Trusted client-IP header (`TRUSTED_PROXY_HEADER`)

The per-IP limits (widget sessions and sends, failed API-token attempts,
self-hosted sign-up) need a client IP. Next.js route handlers do not expose
the socket address, so the app takes it from proxy headers:

| Deployment | `TRUSTED_PROXY_HEADER` unset | `TRUSTED_PROXY_HEADER` set |
| --- | --- | --- |
| One proxy that overwrites or appends `X-Forwarded-For` (nginx `$proxy_add_x_forwarded_for`, Caddy, Traefik) | Keys on the **last** `X-Forwarded-For` entry, the address the proxy saw. Entries a client forges to its left are ignored. No action needed. | Only that header is read. Needed only if the proxy offers a dedicated one. |
| Cloudflare in front of a proxy | The last entry is the Cloudflare/proxy hop, so many visitors share a bucket. Set the header. | `TRUSTED_PROXY_HEADER=cf-connecting-ip` keys on the visitor. |
| No proxy (port 3000 published directly) | No `X-Forwarded-For`, so no IP: the limits are **skipped** (fail open) and the app logs a one-time warning. A client that sends its own `X-Forwarded-For` picks its own bucket. | Requests without the header share one `unknown` bucket. |

Before #219 the app keyed on the **first** `X-Forwarded-For` entry, which any
caller can set. That let one caller lock out another IP's API-token calls for
60 seconds (20 failed tokens as the victim's address) or dodge the limit by
rotating the value. Run the app behind a reverse proxy; a directly exposed
instance has no trustworthy client IP and is not rate limited per IP.

When `TRUSTED_PROXY_HEADER` is set, only that header is read and
`X-Forwarded-For` is ignored. **Precondition: the origin must accept traffic
only from that proxy** (firewall the app port, or use authenticated origin
pulls / a Cloudflare Tunnel). Otherwise an attacker reaches the origin
directly and sets the header, which is as spoofable as `X-Forwarded-For`.
Requests missing the header all share one bucket, so a misconfiguration
limits more, never less.

The app logs a one-time warning when it cannot determine an IP, and when
`X-Forwarded-For` carries several entries while `TRUSTED_PROXY_HEADER` is
unset. The first means no proxy header reached the app. The second is normal
if a visitor's own proxy added an entry, but it also appears behind a
multi-proxy chain such as Cloudflare in front of your proxy, where the limits
key on the outer hop. If that is your setup, set `TRUSTED_PROXY_HEADER`
under the precondition above. When `X-Forwarded-For` is absent the app falls
back to `X-Real-IP`, which a client can set itself unless your proxy
overwrites it.

## Add Products from scripts or coding agents

Besides the dashboard ([add-product.md](add-product.md)), a Workspace admin can
create an [API token](api-tokens.md) and onboard Products over HTTP: the
[API quickstart](api-quickstart.md) walks through it with `SUPPORTSEAL_URL` set to
your `NEXT_PUBLIC_APP_URL`, and [openapi.json](openapi.json) is the machine-readable
contract, served live by your installation at `/api/openapi.json` (public, with
your own address as the server default). It needs no Stripe, hosted API or external service.

## Backups

- **Database**: standard `pg_dump`/`pg_dumpall` on the `db` service (or a
  managed snapshot). This holds every Workspace, Product, conversation,
  message and the delivery ledger.
- **Attachments**: back up the volume mounted at `STORAGE_DIR` (or your
  S3-compatible bucket if you swap the storage adapter).

## Maintenance: purge stale anonymous chat visitors

Every widget session boot creates a chat-visitor row; rows that never
started a conversation and were never identified would otherwise accumulate
forever (the visitor cookie lasts a year). Run this manual script when
cleanup is needed (issue #82); it has no scheduler or guaranteed physical
purge deadline. Export `DATABASE_URL` in the shell for Postgres; the script
does not load `.env` automatically.

```bash
# dry run (default; --dry-run also accepted): reports the count only
npm run db:purge-visitors
# delete, keeping the default 30-day unseen window
npm run db:purge-visitors -- --apply
# lengthen the retention window (--days cannot go below 30)
npm run db:purge-visitors -- --apply --days 60
# docker compose deployment (the migrate image carries the source and deps)
docker compose run --rm --entrypoint npx migrate tsx scripts/purge-stale-visitors.ts --apply
```

A row is deleted only when it is **anonymous** (no email, name or external
user id), **never linked to a conversation** (and never created one — a
deleted conversation leaves a marker on its visitor) and **not seen for the
retention window** (default 30 days, `lastSeenAt` strictly before the
cutoff). Identified visitors, current and past conversation participants
and recent visitors are never touched, and every condition is re-checked
at deletion time, so a visitor who returns or identifies themselves while
the script runs is spared. The script is idempotent, prints aggregate
counts only, and is safe to run alongside the live app or concurrently
with itself. It needs `DATABASE_URL`; without it (development only) it
targets the local PGlite database instead.
Returning browsers whose anonymous rows were purged receive fresh sessions
at widget boot. This does not delete Conversations, Messages or diagnostics,
or change their separate retention rules or backup retention.

## Upgrades

```bash
git pull
docker compose build
docker compose run --rm migrate   # applies pending prisma migrations
docker compose up -d
```

The migrate step is idempotent. Check `GET /api/health` after upgrading.

## Security notes

- Keep `BETTER_AUTH_SECRET` and `INBOUND_WEBHOOK_SECRET` secret; rotate by
  setting a new value and restarting (sessions invalidate; widgets re-issue
  visitor cookies automatically).
- The widget key in the embed snippet is public by design — it only works on
  the domains you allowlisted for that Product.
- Registration closes itself once the Workspace exists; users join by
  invitation only.
- Attachments are validated (type-sniffed, size-capped) and served with
  `nosniff` + authorized access only.

## Uninstall

`docker compose down -v` removes containers, network and volumes (all data).
