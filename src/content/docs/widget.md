# Install the chat widget

Find the snippet in **Settings → Products → your Product → Widget**. The widget
key in it is public by design: it only works on the domains you allowed for that
Product.

## Plain HTML

Paste the script tag before `</body>` on every page that should show the widget:

```html
<script
  async
  src="https://YOUR-HOST/widget.js"
  data-key="WIDGET_KEY"
></script>
```

Keep the `src` from the dashboard snippet. The script server is not your site's
origin; do not change it to your own domain.

## Next.js (App Router)

Use `next/script` instead of the script tag. Render it once in your root
layout; `next/script` deduplicates the loader across route changes.

```jsx
"use client";

import Script from "next/script";
import { useEffect } from "react";

export default function SupportWidget({ user }) {
  const id = user?.id;
  const email = user?.email;
  const name = user?.name;

  useEffect(() => {
    window.SupportSealWidget = window.SupportSealWidget || { q: [] };
    if (id) window.SupportSealWidget.q.push(["identify", { id, email, name }]);
  }, [id, email, name]);

  return (
    <Script
      id="support-widget-script"
      src="https://YOUR-HOST/widget.js"
      data-key="WIDGET_KEY"
    />
  );
}
```

## Plain React (no Next.js)

Without `next/script`, inject the loader yourself. Render it once in your app
shell.

```jsx
"use client";

import { useEffect } from "react";

export default function SupportWidget({ user }) {
  const id = user?.id;
  const email = user?.email;
  const name = user?.name;

  useEffect(() => {
    window.SupportSealWidget = window.SupportSealWidget || { q: [] };
    if (id) window.SupportSealWidget.q.push(["identify", { id, email, name }]);

    if (document.getElementById("support-widget-script")) return;
    const script = document.createElement("script");
    script.id = "support-widget-script";
    script.async = true;
    script.src = "https://YOUR-HOST/widget.js";
    script.dataset.key = "WIDGET_KEY";
    document.body.appendChild(script);
  }, [id, email, name]);

  return null;
}
```

Replace `https://YOUR-HOST` and `WIDGET_KEY` with the values from your snippet.

## One codebase, many sites

Give every site its own Product — its own widget key, domains and branding.
In one codebase serving several hostnames, read the key from an environment
variable and render nothing when it is unset:

```jsx
const widgetKey = process.env.NEXT_PUBLIC_SUPPORTSEAL_WIDGET_KEY;
if (!widgetKey) return null; // no key for this deployment: render nothing
```

`NEXT_PUBLIC_*` values (and `VITE_*` in Vite,
`import.meta.env.VITE_SUPPORTSEAL_WIDGET_KEY`) are inlined at build time, so a
changed key needs a rebuild, and one build cannot vary the key per request.

## Get the key without the dashboard

Workspace admins can read keys over the API: sign in with
`POST /api/auth/sign-in/email` (saving the session cookie), then request
`GET /api/products` or `GET /api/products/PRODUCT_ID`. Each Product comes back
with its `widgetKey` and `formKey`. Non-admins and other Workspaces get `403` or `404`. See the
[widget integration guide](https://github.com/pietervw/SupportSeal-app/blob/main/docs/widget-integration.md#get-the-widget-key-without-the-dashboard)
for a curl example.

## Identify signed-in visitors (optional)

Pass your own app's user as `id`, `email` and `name` strings. Identity is support
context, not authentication; never send passwords, tokens or secrets. Omit it for
anonymous chat.

## Troubleshooting

- **Widget does not appear:** the page's hostname is not in the Product's domains.
- **Testing before deploy:** use **Open test page** in onboarding, or allow `localhost`.
- **Check an allowlist entry from CI:** request the widget's config endpoint and
  expect `200` only for allowed hostnames (`403 {"error":"origin_not_allowed"}`
  otherwise; an unknown key returns `404`):

  ```sh
  curl -fsS "https://YOUR-HOST/api/widget/config?key=pk_YOUR_KEY&host=www.example.com" >/dev/null
  ```

  Probe `www.example.com` and `example.com` separately: they are distinct
  entries, and `*.example.com` does not cover the apex.
- **Key abused or spamming:** see the
  [widget abuse model](https://github.com/pietervw/SupportSeal-app/blob/main/docs/widget-integration.md#widget-abuse-model) —
  narrow the allowlist, or archive the Product and create a new one.
