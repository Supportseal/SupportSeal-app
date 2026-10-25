# Add a Product to an existing instance

Runbook for adding another Product to a SupportSeal instance whose Workspace
already exists (hosted at `dashboard.supportseal.app`, or a self-hosted
installation). It needs a Workspace **admin** account and no server access:
every step below is a dashboard action. For what the widget and email
settings mean in more depth, see [widget-integration.md](widget-integration.md).

You need: the Product's name, the exact hostnames visitors use to reach its
site (for example `example.com` and `www.example.com`), and the ability to
edit that site's HTML or layout.

## 1. Create the Product

1. Sign in and open **Settings → Products**.
2. Under **Add a Product**, enter the **Product name** and a **Primary
   colour**. You can also list **Domains** here, but you can add or fix them
   afterwards (step 2).
3. Choose **Create Product**. The Product appears in the list and opens its
   settings. A widget key and an inbound support address are generated
   automatically.

Products keep separate domains, widget keys, support addresses and branding,
while all conversations land in the one shared inbox.

## 2. Allow the site's domains

Open the Product, then **General → Domains**. The widget only loads on
listed hostnames. Entries match the **exact hostname**:

| You enter | It allows | It does not allow |
| --- | --- | --- |
| `example.com` | `example.com` | `www.example.com` |
| `www.example.com` | `www.example.com` | `example.com` |
| `*.example.com` | `www.example.com`, `app.example.com`, … | `example.com` |

If visitors can reach the site on both `example.com` and `www.example.com`,
allow both. When you paste either one, the card offers to add the other too
(**Also allow …**, ticked by default; untick it if you only want one).
Pasted URLs such as `https://Example.com/pricing` are reduced to their
hostname. Subdomains like `app.example.com` are their own entry (or covered
by a `*.` wildcard). `localhost` always works in development, and no DNS
changes are needed for this step.

## 3. Check the support email

Open **Email** on the Product.

- **Zero config (default):** use the generated inbound address
  (`product_xxx@…`). Forward your existing support address, such as
  `support@example.com`, to it with your mail provider, or just give it to
  testers.
- **Public support address (optional):** enter the address customers see in
  **Support email** and save, so SupportSeal knows it is your own address
  and does not loop mail back to it.
- **Custom mail domain (optional):** follow **Show DNS records**, add the
  records at your DNS provider, then **Verify records**. DNS can take minutes
  to hours. Chat and the generated address work meanwhile.

Replies are sent from the managed sender, so you do not configure outbound
mail per Product.

## 4. Find the widget key and install the snippet

Open **Widget** on the Product. The **Chat widget embed** card shows the
install snippet and the **Widget key** (`pk_…`) with copy buttons. The key is
public and identifies the Product; there is no secret to manage.

- **Plain HTML:** paste the snippet just before `</body>` on every page that
  should show the widget. Keep the script URL exactly as shown.
- **Next.js (App Router):** use the `next/script` component in
  [widget-integration.md](widget-integration.md#nextjs-app-router) instead of
  the tag, with the same server URL and key. For plain React, use the effect
  snippet in the same guide.
- **Identify signed-in users (optional):** push
  `["identify", { id, email, name }]` onto `window.SupportSealWidget.q` with
  your own signed-in user. Identity is support context, not authentication;
  never pass passwords or tokens.

Use **Open test page** to try the widget before the site goes live. It stays in
preview and sends nothing to the inbox.

## Onboard a Product through the API

Scripts and coding agents can do steps 1, 2 and 4 over HTTP with a Workspace API
token, on the hosted tier and on a self-hosted installation alike. Follow the
[API quickstart](api-quickstart.md): it covers creating the token (a dashboard
step), `POST /api/products`, `PATCH /api/products/{id}` for domains, reading the
widget key, the embed snippet, the error table and retry advice. The full
contract is [openapi.json](openapi.json). Steps 3 (email) and 5 (smoke test)
stay as here.

## 5. Smoke test

Run through this on the live site (or a staging site whose hostname you
allowed):

- [ ] The Product shows under **Settings → Products** with the right name and
      colour.
- [ ] Every hostname visitors use is listed under **Domains**, including both
      apex and `www` where both resolve.
- [ ] The widget bubble appears on the site. If not, open the browser console
      and look for `Widget not loaded:`, which names the hostname that was
      rejected; add that exact hostname under **Domains**.
- [ ] Send a chat message from the widget; it shows up in the **Inbox**
      tagged with this Product. Reply from the inbox and confirm the widget
      receives it.
- [ ] Email a test message to the generated inbound address; it appears in the
      inbox under this Product. Reply and confirm the reply arrives from
      `"<Product> Support"`.
- [ ] If forwarding is set up, send a test to the public support address and
      confirm it lands in the inbox.

## Advanced

Not needed for the zero-config path above.

- **Self-hosted instances** must have an inbound email provider and outbound
  mail configured before the email checks can pass; see
  [self-hosting.md](self-hosting.md#email-setup).
- **Custom mail domain DNS** (MX and TXT ownership records) is described in
  [self-hosting.md](self-hosting.md#custom-inbound-mail-domain-optional); on
  the hosted tier, use the records the **Email** tab shows.
- **Legacy snippets** that load `https://supportseal.app/widget.js` keep
  working through the legacy routes; new snippets use the dashboard origin.
  Never swap the script URL for your own site's URL.
- **Read the widget key over the API:** sign in as a Workspace admin with
  `POST /api/auth/sign-in/email` (the better-auth session cookie), then
  `GET /api/products` returns `{ products: [...] }` and
  `GET /api/products/[id]` returns one bare object. The full curl example,
  status codes and caching notes are in
  [widget-integration.md](widget-integration.md#get-the-widget-key-without-the-dashboard).
  Creating and editing Products needs an API token instead of a session; see
  the [API quickstart](api-quickstart.md).
- **Retiring a Product:** archive it from **General** (**Archive Product**). The widget stops
  loading and its inbound address bounces; conversations are kept.
