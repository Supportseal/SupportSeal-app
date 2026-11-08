# Hosted sign-up funnel analytics (Umami)

Status: shipped for the hosted tier (issue #65). This is marketing-and-funnel
analytics, which the PRD keeps outside the product: hosted-only, never a
source of support metrics. It is separate from the in-product support
reporting designed in [design/analytics.md](design/analytics.md).

## Why

`/register` had page loads but no completed sign-ups, and server logs cannot
tell a bot or link preview from a person who gave up. A page view needs only
a request; the funnel events below need a browser that runs JavaScript and a
visitor who types or clicks, so the gap between steps shows where real
people stop.

## Where it runs

- **Hosted dashboard** (`dashboard.supportseal.app`), only on the sign-up
  funnel pages: `/register`, `/login`, `/forgot-password`, `/reset-password`
  and the `/onboarding` wizard. The script is rendered by the auth layout and
  the onboarding wizard shell, and its before-send hook drops anything sent
  from another path (for example after a client-side move into `/inbox`).
- On only when the build sets `NEXT_PUBLIC_UMAMI_SCRIPT_URL` (https only) and
  `NEXT_PUBLIC_UMAMI_WEBSITE_ID`. Only `docker-compose.hosted.yml` passes
  them, defaulting to the marketing site's Umami website; setting the script
  URL to `off` disables it. `docker-compose.yml`, the Dockerfile defaults
  and `.env.example` leave them empty, so self-hosted images load no tracker (FR-HOST-01, pinned by
  `src/lib/__tests__/analytics.test.ts`). Values are inlined at build time
  because some of these pages are statically rendered, so a change needs a
  redeploy.
- **Never** inside the chat widget, the widget panel or the widget preview.

Use the **same Umami website as the marketing site**. Umami derives sessions
from the website, IP and browser without cookies, so a visitor moving from
the pricing page to sign-up stays one session and a funnel can span both
hosts. Filter by hostname when a report needs one site. If the marketing
script restricts hosts with `data-domains`, that applies only to its own tag.

## Privacy rules

- No names, emails, Workspace or Product names, ids or tokens. `track()`
  (`src/lib/analytics.ts`) only forwards short enum-like strings, numbers and
  booleans and drops anything else.
- Page views exclude query strings and hashes. Id-like path segments become
  `:id`, outside referrers are reduced to their origin.
- Do Not Track is honoured. Umami sets no cookies.

## Events

| Event | Data | Fired when |
| --- | --- | --- |
| page view `/register` | | sign-up page loaded (bots included) |
| `signup_form_started` | `plan` (pro, business, none), `ref` | first keystroke in the sign-up form |
| `signup_social_clicked` | `method` (github, google), `plan`, `ref` | a "Sign up with …" button |
| `signup_submitted` | `method` (email), `plan`, `ref` | the form was submitted |
| `signup_failed` | `method`, `reason` (exists, other) | sign-up rejected |
| `signup_completed` | `method` (email), `plan`, `ref` | account created |
| page view `/onboarding`, `/onboarding/product`, `…/domain`, `…/mail`, `…/install` | | each wizard step (social sign-ups land on `/onboarding` too) |
| `login_completed` / `login_failed` | `method` (email) | password sign-in result |

`ref` is the first-touch channel from marketing links (`?ref=hn`); only a
short lowercase slug is kept, anything else reports as `none`.

## Reading the funnel

In Umami, build a funnel on the website: `/register` →
`signup_form_started` → `signup_submitted` → `signup_completed` →
`/onboarding/product` → `/onboarding/install`. Many page views with no
`signup_form_started` means bots, previews or visitors leaving at first
sight; started but not submitted means the form puts people off; submitted
but not completed means sign-up errors (see `signup_failed` reasons).

The database stays the source of truth for completed sign-ups (`User.createdAt`)
and for anything past onboarding.

## Adding an event

Add the name to `AnalyticsEvent` in `src/lib/analytics.ts`, call
`track(name, data)` from client code on a funnel page, and add a row above.
Data values must be enums or counts.
