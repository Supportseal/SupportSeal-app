# Widget integration

Adding a new Product to an existing instance? Follow the [add-a-Product runbook](add-product.md), or the [API quickstart](api-quickstart.md) to create it and read its widget key over HTTP.

## Start with the widget key

In the dashboard, open **Settings → Products → your Product → Widget**.
Copy the install snippet or the **Widget key** below it. This key is public;
there is no secret-key step for a hosted widget installation. To find the
generated support email address, open the same Product's **Email** tab.

Add the hostname visitors actually use under **General → Domains**:

- `example.com` and `www.example.com` are separate exact entries.
- `*.example.com` covers subdomains such as `www.example.com` and
  `app.example.com`, but does **not** cover `example.com` (the root or apex).
  Add the apex separately if visitors use it.
- Onboarding accepts a pasted URL and keeps its hostname. Allow localhost
  explicitly when testing locally.

Saving allowed domains requires no DNS changes. Once the snippet is installed
and the site's hostname is allowed, reload the site to test the widget.
Custom mail-domain verification does not gate chat.

## Get the widget key without the dashboard

Workspace **admins** can read Product widget keys over the API, for scripts,
CI and agents that install the widget without opening the dashboard. Requests
authenticate with the same session cookie as the dashboard, or with a
Workspace [API token](api-tokens.md) sent as `Authorization: Bearer`.
Non-admin members and other Workspaces get no key.

```sh
# 1. Sign in as an admin; the session cookie is saved in cookies.txt.
curl -c cookies.txt -H "Origin: https://dashboard.example.com"   -H "Content-Type: application/json"   -d '{"email":"admin@example.com","password":"..."}'   https://dashboard.example.com/api/auth/sign-in/email

# 2. List Products with their keys, or fetch one by id.
curl -b cookies.txt https://dashboard.example.com/api/products
curl -b cookies.txt https://dashboard.example.com/api/products/PRODUCT_ID
```

Replace `dashboard.example.com` with your installation's public URL. The list
returns:

```json
{
  "products": [
    {
      "id": "3f6c0a52-...", "name": "Acme App", "archived": false,
      "primaryColor": "#7367f0", "supportEmail": null, "domains": ["acme.example"], "widgetKey": "pk_...", "formKey": "fk_..."
    }
  ]
}
```

`formKey` is for a server-side contact form, not the page; see the
[API quickstart](api-quickstart.md#4-read-the-keys). The single endpoint returns one of those objects. Status codes: `401` without a
session, `403` for non-admins or accounts with no Workspace, `404` for an id
outside your Workspace; error bodies use the JSON envelope in
[api-tokens.md](api-tokens.md#errors). Responses are `private, no-store`, and the server never
logs keys. The widget key stays public by design (see above); this path only removes
the need for a browser.

## Script server and your site's origin

Keep the script URL from the dashboard snippet. New hosted snippets use
`https://dashboard.supportseal.app/widget.js`. Existing snippets using
`https://supportseal.app/widget.js` still work through the legacy widget routes.
For self-hosting, use your installation's public URL.

The script server is different from the **embedding origin**: the address
visitors open, such as `https://www.example.com`. That origin's hostname must
match your Product's allowed domains. Your site does not need the same origin
as the widget server. Do not change the script URL to your own site's URL.

## Plain HTML

Paste the dashboard's script tag just before `</body>` on each page where you
want the widget. It contains the server URL and your Product's widget key.
Send a chat from your site, or use **Open test page** during onboarding to test
before deployment. If the built-in test page is unavailable, you can still
test from an allowed site or an explicitly allowed localhost page.

## Next.js (App Router)

Use `next/script` **instead of** the HTML script tag. Save this as
`SupportWidget.jsx`, render `<SupportWidget />` once in your root layout, and
keep it mounted across route changes. `next/script` deduplicates the loader by
`id`, and the loader also guards itself against double loads, so development
re-mounts are harmless.

Replace `WIDGET_SERVER_URL` with the origin from your install snippet (no
trailing slash) and `WIDGET_KEY` with your Product's widget key. This is the
same example shown in onboarding, where those values are filled in.

```jsx
"use client";

import Script from "next/script";
import { useEffect } from "react";

export default function SupportWidget({ user }) {
  const id = user?.id;
  const email = user?.email;
  const name = user?.name;

  // The queue accepts identity before the script loads and after it.
  useEffect(() => {
    window.SupportSealWidget = window.SupportSealWidget || { q: [] };
    // Optional: pass your app's signed-in user, not a placeholder user.
    if (id) {
      window.SupportSealWidget.q.push(["identify", { id, email, name }]);
    }
  }, [id, email, name]);

  return (
    <Script
      id="support-widget-script"
      src="WIDGET_SERVER_URL/widget.js"
      data-key="WIDGET_KEY"
    />
  );
}
```

To identify a visitor, pass your own app's signed-in user object as
`<SupportWidget user={user} />`, with string `id`, `email` and `name` fields.
There is no global `user` object supplied by the widget. Omit the prop for
anonymous chat. Identity is optional support context, not authentication;
never pass passwords, session tokens or secrets.

## Plain React (no Next.js)

Without `next/script`, inject the loader yourself with an effect. Save this
as `SupportWidget.jsx` and render `<SupportWidget />` once in your app shell.
Keep it mounted across route changes. The `WIDGET_SERVER_URL` and
`WIDGET_KEY` placeholders are the same as above.

```jsx
"use client";

import { useEffect } from "react";

export default function SupportWidget({ user }) {
  const id = user?.id;
  const email = user?.email;
  const name = user?.name;

  useEffect(() => {
    window.SupportSealWidget = window.SupportSealWidget || { q: [] };
    // Optional: pass your app's signed-in user, not a placeholder user.
    if (id) {
      window.SupportSealWidget.q.push(["identify", { id, email, name }]);
    }

    // Install once, including during React development effect re-runs.
    if (document.getElementById("support-widget-script")) return;
    const script = document.createElement("script");
    script.id = "support-widget-script";
    script.async = true;
    script.src = "WIDGET_SERVER_URL/widget.js";
    script.dataset.key = "WIDGET_KEY";
    document.body.appendChild(script);
  }, [id, email, name]);

  return null;
}
```

## One codebase, many sites

Every site you support gets its own Product, with its own widget key, domain
allowlist and branding. When one codebase serves several hostnames — a second
brand, per-tenant subdomains, a staging deployment — read the widget key from
an environment variable instead of hard-coding it, and render nothing when it
is unset:

```jsx
"use client";

import Script from "next/script";

export default function SupportWidget() {
  const widgetKey = process.env.NEXT_PUBLIC_SUPPORTSEAL_WIDGET_KEY;
  if (!widgetKey) return null; // no key for this deployment: render nothing

  return (
    <Script
      id="support-widget-script"
      src="WIDGET_SERVER_URL/widget.js"
      data-key={widgetKey}
    />
  );
}
```

The script server origin stays the same for every site; only the key differs.
Keep the form key (`fk_…`, Developer tab) out of this: it authorises
server-side form posts and is a separate credential.

Build-time inlining caveat: `NEXT_PUBLIC_*` values are inlined when Next.js
builds or dev-serves the app, so a changed key needs a rebuild and redeploy,
and one build cannot serve a different key per request. Vite behaves the same
way with `VITE_*` variables (`import.meta.env.VITE_SUPPORTSEAL_WIDGET_KEY`).

## Test the domain allowlist from CI

The widget boots by calling `GET /api/widget/config` — the same request you
can send to prove an allowlist entry works before (or after) deploying. It is
the supported public probe, with or without a browser:

```sh
# Allowed hostname → 200 {"name":…,"color":…,"availability":…}
curl "https://dashboard.example.com/api/widget/config?key=pk_YOUR_KEY&host=www.example.com"

# Anything else → 403 {"error":"origin_not_allowed"}
curl "https://dashboard.example.com/api/widget/config?key=pk_YOUR_KEY&host=other.example.net"
```

For a CI gate, fail on any non-200 response (an unknown or archived key
returns `404 {"error":"not_found"}`):

```sh
curl -fsS "https://dashboard.example.com/api/widget/config?key=$WIDGET_KEY&host=www.example.com" >/dev/null
```

Notes:

- `host` is the embedding hostname visitors use. Send it without a `Referer`
  header (plain `curl` does), so the probe tests exactly that allowlist entry;
  the widget itself sends its page origin here.
- Probe `www.example.com` and `example.com` separately: they are distinct
  allowlist entries, and `*.example.com` does not cover the apex.
- The response body is the Product's public configuration only; it never
  includes conversations or visitor data.

### Verify the install in the dashboard

Every config request from a valid hostname is also recorded, so you can check
an install without reading server logs: open **Settings → Products → your
Product → Widget** and look at the **Installation** panel.

- **Loaded from** lists the hostnames the widget loaded from, with the time of
  the last load (updated at most once an hour per hostname).
- **Refused hostnames** lists hostnames the widget was refused on in the last
  30 days (a domain you forgot to allow, or a CI probe like the one above),
  with an **Allow** button for Workspace admins. It adds the hostname to the
  Product's domains, with the same apex/`www.` option as the Domains card.

Only the hostname and a timestamp are stored: no IP address, user agent,
cookie or page path. At most 50 hostnames are kept per Product and list, and
this works the same on hosted and self-hosted installations (nothing leaves
your database).

## Widget abuse model

The widget key is public by design, and that is the whole model:

- **What the key grants:** starting visitor sessions and sending messages on
  that Product — what any visitor can do. It grants no read access to
  conversations, the inbox or Workspace data.
- **What the allowlist proves:** the embedding host a browser declares is
  allowlisted. That stops the widget quietly running on a site you did not
  list; it does not stop a scripted client, which can declare any hostname.
  The allowlist is an origin hygiene check, not authentication.
- **What bounds abuse:** rate limits on the endpoints a visitor can drive —
  session start, message sends, stream reconnects and polls, context fetches,
  attachment uploads and session reset (for example 240 reads and 60 writes
  per visitor per minute, plus an overall per-IP cap of 300 requests per
  minute across those endpoints). Endpoints that only mint new sessions or
  accept keyed contact-form submissions have their own IP-only buckets (30
  per minute each), and the preflight check shares the overall per-IP cap.
  Static files — the config probe, `widget.js`, the panel bundle and the
  diagnostics build — are deliberately not rate-limited; they serve no tenant
  data. Limits are enforced in-process, so multi-process deployments get them
  per process.
- **If a key is abused today:** narrow the Product's allowed domains if the
  abuse routes through a hostname you control, or archive the Product and
  create a new one — the new Product gets a fresh key and allowlist, and
  historical conversations are preserved. There is no key rotation short of
  that in V1.

## Email and DNS timing

The included inbound support address needs no DNS changes from you. Copy it
from **Settings → Products → your Product → Email** and send a test email.
Self-hosters must first configure the installation's inbound email provider
as described in the [self-hosting guide](self-hosting.md#email-setup).

Only a custom mail domain needs DNS setup: enter a dedicated domain, choose
**Show DNS records**, add those records at your DNS provider, then choose
**Verify records**. DNS changes may appear within minutes; cached records can
take longer depending on your provider and their time to live (TTL). Retry
verification later if necessary. Continue with the widget and generated email
address while you wait.

## Advanced: self-hosting secrets

Hosted users do not generate server secrets. Self-hosters configure
`BETTER_AUTH_SECRET` in the server environment: it is a random private value
used to sign login sessions and test-page links, not a widget key.

Generate one in a terminal:

```sh
openssl rand -base64 32
```

Save the output as `BETTER_AUTH_SECRET` in your server's environment and restart
the app. Keep it out of browser code and source control. See the
[environment reference](self-hosting.md#environment-reference) for the full
self-hosting setup.
