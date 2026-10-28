# Hosted analytics (Umami)

Status: shipped for the hosted tier. This is the marketing-and-funnel
analytics that the PRD keeps outside the product (third-party analytics is
hosted-only and never the source of support metrics). It is separate from
the in-product support reporting designed in [design/analytics.md](design/analytics.md).

## Where it runs

- **Hosted dashboard** (`dashboard.supportseal.app`): on when the build sets
  `NEXT_PUBLIC_UMAMI_SCRIPT_URL` (https only) and
  `NEXT_PUBLIC_UMAMI_WEBSITE_ID`. Only `docker-compose.hosted.yml` passes
  them; `docker-compose.yml`, the Dockerfile defaults and `.env.example` leave
  them empty, so self-hosted images load no tracker (FR-HOST-01, pinned by
  `src/lib/__tests__/analytics.test.ts`). Values are inlined at build time
  because some funnel pages are statically rendered.
- **Marketing site** (`supportseal.app`, private repository): same Umami
  website, its own env settings.
- **Never** inside the chat widget, the widget panel or the widget preview:
  visitors of customers' sites are not our users.

Use **one Umami website for both hosts**. Umami derives sessions from the
website, IP and browser without cookies, so a visitor moving from the pricing
page to sign-up stays one session and funnels can span both hosts. Filter by
hostname when a report needs one site.

## Privacy rules

- No names, emails, message text, Workspace or Product names, ids or tokens.
  `track()` (`src/lib/analytics.ts`) only forwards short enum-like strings,
  numbers and booleans and drops anything else.
- Page views exclude query strings and hashes. A before-send hook rewrites id
  segments (`/inbox/<uuid>` → `/inbox/:id`, `/invite/<token>` →
  `/invite/:token`), reduces outside referrers to their origin and removes the
  unread count from titles.
- Do Not Track is honoured. Umami sets no cookies.
- Uncaught browser errors send only the error class (`TypeError`), never the
  message or stack.

## Dashboard events

| Event | Data | Fired when |
| --- | --- | --- |
| `signup_form_started` | `plan` (pro, business, none) | first focus in the sign-up form |
| `signup_completed` | `method` (email), `plan` | account created |
| `signup_failed` | `method`, `reason` (exists, other) | sign-up rejected |
| `login_completed` / `login_failed` | `method` | password sign-in result |
| `onboarding_error` | `step` (product, domain, mail) | a wizard step shows an error |
| `onboarding_domains_skipped` | | "Skip for now" on the domain step |
| `widget_first_message` | | install step sees the first message arrive (activation) |
| `checkout_started` | `plan`, `interval`, `from_pricing` | redirecting to Stripe Checkout |
| `checkout_failed` | `plan`, `reason` | checkout could not start |
| `checkout_completed` / `checkout_cancelled` | `plan` (pending if the webhook is still on its way) | return from Stripe |
| `billing_portal_opened` | | redirecting to the Stripe portal |
| `reply_sent` | `kind` (reply, note), `channel`, `saved_reply`, `attachments` | composer send succeeded |
| `reply_failed` | `kind` | composer send failed |
| `conversation_status_changed` | `status`, `from` (thread, list) | status change saved |
| `saved_reply_inserted` | | saved reply put into the composer |
| `saved_reply_created` | `from` (composer, settings) | saved reply created |
| `attachment_failed` | `status` (HTTP code) | upload rejected |
| `client_error` | `kind`, `name` | uncaught error (max five per page load) |

Funnel steps that are their own page are measured with page views:
`/register`, `/onboarding` (Workspace), `/onboarding/product`,
`/onboarding/domain`, `/onboarding/mail`, `/onboarding/install`, `/inbox`,
`/settings/billing`.

## Adding an event

Add the name to `AnalyticsEvent` in `src/lib/analytics.ts`, call
`track(name, data)` from client code (or render `<TrackOnMount>` from a server
page), and add a row above. Data values must be enums or counts.
