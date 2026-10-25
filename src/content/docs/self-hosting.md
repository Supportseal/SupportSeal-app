# Self-hosting

One app container, one PostgreSQL database, no external service requirements.
A self-hosted installation serves **exactly one Workspace** with unlimited
Products and agents, and never needs Stripe, a hosted API or external telemetry.
The complete guide, including backups and maintenance scripts, is
[docs/self-hosting.md on GitHub](https://github.com/Supportseal/SupportSeal-app/blob/main/docs/self-hosting.md).

## Quick start

```bash
git clone https://github.com/Supportseal/SupportSeal-app.git
cd supportseal
cp .env.example .env        # then edit (see below)
docker compose up -d
```

| Service   | What it does |
| --------- | ------------ |
| `db`      | PostgreSQL 17 with a persistent volume |
| `migrate` | One-shot `prisma migrate deploy` before the app boots |
| `app`     | The Next.js standalone build on port 3000 (health: `/api/health`) |

Open `http://<host>:3000`. On a fresh install the first visit goes to
`/register`; the first account becomes the Workspace Admin. Registration then
closes: teammates join by invitation from **Settings → Team**.

## Environment

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `DATABASE_URL` | yes | e.g. `postgresql://supportseal:pass@db:5432/supportseal`. Your own PostgreSQL must run with `timezone=UTC`. |
| `BETTER_AUTH_SECRET` | yes | Random private secret signing sessions. Generate with `openssl rand -base64 32`. Never put it in browser code. |
| `NEXT_PUBLIC_APP_URL` | yes | Public origin, e.g. `https://support.example.com`. Drives embed snippets, emails and auth. |
| `NEXT_PUBLIC_APP_NAME` | no | Brand name shown in the UI. |
| `STORAGE_DIR` | no | Attachment directory. Mount a volume. |
| `INBOUND_WEBHOOK_SECRET` | for email | Shared secret for the inbound-mail webhook. URL-safe: `openssl rand -hex 32`. |
| `INBOUND_EMAIL_DOMAIN` | for email | Domain receiving forwarded support mail, e.g. `inbound.example.com`. |
| `SENDGRID_API_KEY` or `SMTP_URL` | for email | Outbound provider. Without one, replies are recorded but not delivered. SendGrid wins if both are set. |
| `TRUSTED_PROXY_HEADER` | no | Header your proxy sets with the real client IP (e.g. `cf-connecting-ip`). |

Never set `HOSTED_MODE` on a self-hosted install.

## Support email

1. **Settings → Products → your Product → Email** shows the generated inbound
   address (`product_xxx@your-inbound-domain`).
2. Forward `support@yourproduct.com` to that address.
3. Point your provider's webhook at `https://<your-host>/api/email/inbound` with
   the header `x-supportseal-inbound-secret: <INBOUND_WEBHOOK_SECRET>`. For
   SendGrid Inbound Parse use `https://<your-host>/api/email/inbound?secret=<INBOUND_WEBHOOK_SECRET>`.
4. Configure `SMTP_URL` or `SENDGRID_API_KEY` so replies are delivered.

## HTTPS and reverse proxy

Terminate TLS in front of the app (Caddy, Traefik, nginx). Three requirements:

- **Do not buffer SSE.** The app sends `X-Accel-Buffering: no`; that is enough for stock nginx.
- **Never gzip `text/event-stream`.** Exclude it from `gzip_types` (nginx) or the `encode` matcher (Caddy).
- **Preserve `Host`** and pass `X-Forwarded-For`; the per-IP rate limits key on its last entry (the address your proxy saw) and ignore forged entries to its left.

If the app sits behind Cloudflare, set `TRUSTED_PROXY_HEADER=cf-connecting-ip`
and firewall the origin so only the proxy can reach it. Without any proxy
header (port 3000 exposed directly) per-IP limits are skipped and the app
logs a warning, so run it behind a reverse proxy.

## Upgrades

```bash
git pull
docker compose build
docker compose run --rm migrate
docker compose up -d
```

Migrations are idempotent. Check `GET /api/health` afterwards.

## Backups

Back up the database (`pg_dump` on the `db` service) and the `STORAGE_DIR` volume.
