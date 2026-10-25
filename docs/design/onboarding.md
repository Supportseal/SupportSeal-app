# Onboarding — V1 design

Status: design direction for the build thread. Grounded in [PRD](../PRD.md)
(principle "Make the first real customer message easy to receive; make the
second Product easy to add"; journeys 1, 2, 3, 6), [FRD](../FRD.md)
(FR-ACC-01, FR-PROD-01, FR-CHAT-01, FR-EMAIL-01, FR-HOST-01, acceptance
path), [product-positioning.md](../product-positioning.md) ("First-use
promise").

**UI kit:** the in-repo kit (`src/components`, `src/styles/tokens.css`; paths below are relative to `src/`). Colours only via `--vx-*` tokens.

## Scope

From "no account" to "first real message answered" (first aha), then
"second Product in the same inbox" (second aha). Covers registration, the
short blocking setup, the persistent setup checklist, invited-user
onboarding and self-hosted first run. Detailed settings forms live in
`product-settings.md`; the widget itself in `chat-widget.md`.

## Principles applied

- **Block only on what's required to test**: Workspace name → Product name
  and colour → domain. Everything else (email, second Product, teammates)
  is a checklist item, not a gate (do not force customers
  through ten settings pages).
- Sensible defaults (preset colour, Workspace name suggestion), copy
  buttons, live preview, test actions, visible success, one clear next step.

## Flow

```
Register ─▶ 1 Workspace ─▶ 2 Product ─▶ 3 Domain ─▶ 4 Install & test ─▶ Inbox
 (auth)      (name)        (name, colour,  (domains,   (snippet, test page,   (checklist
                            live preview)   localhost)  wait for message)       continues)
```

### Register (auth layout)

Centred card (`app/(auth)/register/page.tsx` structure; simplified
`app/(auth)/layout.tsx`): name, email, password, a Create account button,
and a link to sign in. Email/password is local auth (ADR-0002). No plan
picker: hosted Workspaces start on the default plan (billing is managed
later under Settings → Billing).

### Setup wizard: steps 1–3 (`/onboarding`)

A focused full-page layout **without** the sidebar: logo top-left, "Sign
out" top-right, content `max-w-2xl` centred. Progress uses `FormWizard`
(`components/ui/form-wizard.tsx`, `variant="numbered"`, `orientation=
"horizontal"`, `modern`) with 4 steps: Workspace · Product · Domain ·
Install. Step buttons navigate back only to completed steps; forward
navigation is via the Continue button. Actions use `WizardNav` (Previous
secondary label button; primary "Continue").

1. **Workspace**: one field, "Workspace name" (default suggestion: "{First
   name}'s Workspace"), with hint "Your team and all your Products live
   here." (FR-ACC-01).
2. **Product**: two-column layout on `≥ md`:
   - Left: "Product name" (`Input`, e.g. "Acme Analytics"; hint "Customers
     see this name in the chat widget and emails"). "Primary colour" as a
     `RadioGroup` of 8 preset swatches (`components/ui/radio-group.tsx`,
     custom swatch items, each with an accessible colour name). The presets
     are the ones in `brand.md` (blue, violet, pink, red, orange, amber,
     cyan, slate), chosen to stay clear of SupportSeal's own mint green;
     blue `#2563EB` is preselected. Also a
     "Custom" hex `Input` with a colour preview square. A contrast warning
     appears if the colour is under 3:1 against white ("may be hard to see
     on light pages"); it is advisory, not blocking.
   - Right: **live widget preview**: the real widget UI in preview mode
     (static, no network) showing launcher and open panel in the chosen
     colour and name, updating as the user types. Below `md` it collapses
     under the fields as a launcher-only preview with an "Show panel" toggle.
3. **Domain**: `TagInput` (`components/ui/tag-input.tsx`) for "Where will
   the widget run?". Entries are normalised to hostnames (paste a full URL →
   `app.example.com`). Hints: "Add each site that embeds the widget, e.g.
   example.com and www.example.com as separate exact entries. Use
   *.example.com for subdomains, but add example.com separately for the
   root (apex). Saving allowed domains requires no DNS changes." (*Default:* one allowed-domains list, exact hostname
   matches, with an explicit `*.` wildcard for subdomains that doesn't
   cover the apex; see `product-settings.md`.) A `Switch` (`components/ui/switch.tsx`)
   "Allow localhost for development" is on by default in onboarding
   (FR-CHAT-01 explicit localhost path). A secondary "Skip for now, I'll
   test on localhost" continues without a production domain; the checklist
   keeps "Add your domain" open.

### Step 4: Install & test (still in the wizard)

- **Snippet**: code block (`bg-surface-2 rounded-lg font-mono text-sm`,
  horizontally scrollable) with the one-line script tag containing the
  public key plus a `CopyButton` (idle "Copy" → "Copied"
  2.5s; "Copy failed, select the text manually" on clipboard error;
  healthprovider `SupportEmailCopyButton` pattern). Note under it: "This key
  is public. It only works on the domains you allowed."
- A collapsed **Next.js / React** disclosure shows the client-component
  example from [the integration guide](../widget-integration.md), with the
  installation URL and Product key filled in. It injects the script once and
  queues optional identity before load; `user` must come from the integrating
  app's signed-in user. Anonymous chat needs no user object or secret.
- State the script server URL separately from the embedding site's origin:
  the latter's hostname must be allowed. Hosted snippets use the dashboard
  origin; legacy apex snippets still work. Link directly to **Product settings
  → Widget** for the public key and **→ Email** for the support address.
- Mail-domain setup is optional: the generated address needs no customer DNS
  changes. Enter a custom domain before requesting its records; allow for
  DNS caching during verification. Chat does not wait for mail DNS.
- Put the integration guide and self-hosting secret instructions in an
  **Advanced** disclosure. Hosted users do not generate server secrets.
  Self-hosters are told what `BETTER_AUTH_SECRET` means, how to generate it,
  and where to configure it. Unavailable test-page copy directs users to test
  from an allowed site without requiring knowledge of environment variables.
- A collapsed "Have a contact form instead of a chat widget?" disclosure:
  explains that the site's server can post submissions to
  `POST /api/widget/form` with the Product's `fk_…` form key (no widget
  needed) and links to Product settings → Developer → Contact-form
  endpoint, where the key and a copyable `curl` example live (issue #154).
- **Test it**, two options:
  - "Open test page" (new tab): a SupportSeal-hosted page that embeds this
    Product's widget, so users can test before deploying. *Default*
    security model: the button requests a **signed, single-Product test
    token** (Admin only, expires after 30 minutes). The page passes it to
    the widget, and the service accepts the SupportSeal origin for that
    Product **only** with a valid token. No allowlist entry is added, and the
    token grants nothing beyond a normal visitor session. Test Conversations
    are ordinary Conversations with an automatic "test" tag, and they count
    for usage like any other.
  - "I've added it to my site": a hint to open the site and send a chat.
- **Waiting state**: a live card "Waiting for your first message…" with a
  subtle pulsing dot, listening on the realtime stream for the first
  Conversation of this Product (polling fallback every 5s). If no message
  arrives within ~2 minutes, add a troubleshooting disclosure: domain not
  allowed, localhost disabled, ad blockers, script placement.
- **Success**: the card turns `success` ("First message received from
  Visitor 4F2A") and shows the message text, with a primary button "Open it
  in your inbox". This completes the wizard and marks "Send a test
  message" done.
- "Skip for now" (text button) finishes the wizard and goes to the inbox
  with the checklist open.

### Setup checklist (persistent, after the wizard)

A `Card` (`components/ui/card.tsx`) titled "Get set up" with a `Progress`
bar (`components/ui/progress.tsx`) and n/6 count. It appears:

- at the top of the inbox list's empty state while there are no
  Conversations, and
- as a sidebar footer entry "Setup n/6" that opens the checklist in a
  `Popover`/`Sheet` at any time.

Items (each: status icon, title, one line, action button; completed items
collapse to a single struck-through line):

| # | Item | Done when | Action |
| --- | --- | --- | --- |
| 1 | Install the widget | A widget config request arrives from an allowed origin (or item 2 completes) | Show snippet (Product settings → Widget) |
| 2 | Send a test message | First Conversation exists for any Product | Open test page |
| 3 | Reply from your inbox | First agent reply sent | Open the Conversation |
| 4 | Set up support email | First inbound email received at the Product's forwarding address (FR-EMAIL-01) | Product settings → Email |
| 5 | Add your second Product | Workspace has ≥ 2 Products | New Product flow; afterwards the inbox opens at All Products (second aha) |
| 6 | Invite a teammate | An invite has been sent | Settings → Team |

- Agents don't see the checklist (all items are Admin actions except 3).
- When all items are done, the card shows a brief success state ("You're
  set up") and the sidebar entry disappears. The user can dismiss the
  checklist at any time ("Hide setup guide"); it stays reachable under
  Settings → Workspace.
- State is derived server-side from real data where possible, not from
  clicks, so it stays true across devices and teammates.

### Invited teammate

Accept-invite page (auth layout): shows "{Inviter} invited you to
{Workspace}" and asks for name and password (email is prefilled and
read-only). Then it lands directly in the inbox. No wizard, no checklist.
Expired/used invite: "This invitation is no longer valid. Ask {Workspace}'s
admin for a new one."

### Self-hosted first run (FR-HOST-01, the maintainer: single Workspace, blocked)

- Fresh install with no Workspace: `/` redirects to `/register`, headed
  "Set up SupportSeal". The first account becomes the Admin, and step 1
  (Workspace) is part of this first run.
- After the Workspace exists, public registration closes: `/register`
  shows "Registration is closed. Ask your administrator for an invitation."
  and step 1 never appears again.
- No billing, plan or hosted-service references anywhere in self-hosted
  onboarding. The test page is served by the self-hosted instance itself.

## Components

| Need | Source | Notes |
| --- | --- | --- |
| Step progress | `components/ui/form-wizard.tsx` (`FormWizard`, `WizardNav`) | Numbered, horizontal, `modern` |
| Fields | `components/ui/input.tsx`, `components/ui/label.tsx`, `components/ui/form-field.tsx` (`Field`, `FieldHint`) | |
| Colour swatches | `components/ui/radio-group.tsx` | Custom swatch rendering |
| Domains | `components/ui/tag-input.tsx` | Add remove-button aria-labels; hostname normalisation |
| Localhost toggle | `components/ui/switch.tsx` | |
| Checklist | `components/ui/card.tsx`, `components/ui/progress.tsx`, `components/ui/button.tsx` | |
| Success / errors | `components/ui/alert.tsx` | |
| Waiting state | `components/ui/spinner.tsx` or a pulsing dot | Reduced motion → static dot |
| Copy | new `CopyButton` | |
| Auth card | `app/(auth)/layout.tsx`, `app/(auth)/register/page.tsx` | Drop illustration/template copy |
| Widget preview | widget bundle in preview mode | See `chat-widget.md` |

Reference patterns (not code to copy): healthprovider
`DashboardActivationCard.tsx` (numbered activation steps tied to real
data), sealaudit `workspace-onboarding.tsx` (focused full-page onboarding
shell).

## States

| State | Behaviour |
| --- | --- |
| Validation | Inline field errors below each input on blur and submit; Continue stays enabled and focuses the first invalid field |
| Submitting | Button shows `Spinner` and "Creating…"; inputs disabled; no double submit |
| Server error | `Alert` danger above the actions; values preserved |
| Invalid domain entry | Chip rejected with inline message "Enter a hostname like app.example.com" |
| Duplicate Product name | Allowed (unrelated Products may share names); no error |
| Refresh mid-wizard | Resume at the first incomplete step (state comes from the server: Workspace exists? Product exists?) |
| Waiting timed out | Troubleshooting disclosure (see step 4) |
| Realtime unavailable | Waiting card falls back to polling silently |
| Clipboard blocked | CopyButton error label; the snippet text is selectable |

## Responsive

- Wizard content `max-w-2xl`. The Product step is two columns on `≥ md`,
  one column below, with a launcher-only preview.
- `FormWizard` on `< md`: show only numbered circles with the current step
  title (the theme hides connector lines below `md`).
- Code blocks scroll horizontally and never wrap the key.
- The checklist card is full width in the list pane; on `< lg` it opens in
  a bottom `Sheet` from the sidebar entry.

## Accessibility

- Wizard steps: `<ol>` with `aria-current="step"`; the step heading is an
  `<h1>` focused on step change so screen readers announce it.
- Colour swatches are radio inputs with names ("Blue", "Violet"…) and a
  visible selected ring; custom hex has a label.
- The waiting card uses `role="status"` (polite) so the success is
  announced.
- The checklist is an `<ol>`; completed items expose "completed" in text.
- All actions are keyboard reachable; no drag-only interactions.

## Not in V1

Demo/seeded data (out of V1 by decision) · onboarding analytics funnels
(Umami out of V1) · plan selection or payment in onboarding · framework-specific
install guides (React/Vue/Next tabs) · import from other help desks · custom
greeting, logo or launcher position in the preview (V2) · email/DNS
verification wizard for custom sender domains (V2) · product tours or
coach marks · required onboarding survey.

## Decisions and defaults

See `docs/open-questions.md`, "Design decisions (2026-09-25)".

- **Test page**: *default:* a signed, single-Product, 30-minute test token
  (step 4). It still needs security review in the widget PR against
  FR-CHAT-01 and FR-SEC-01. If rejected, fall back to localhost-only
  testing with a downloadable HTML file.
- **Domains**: *default:* one list, exact hostnames, `*.` wildcard for
  subdomains.

## Open points

- **"Widget installed" detection**: item 1 assumes the service can observe
  widget config loads per Product. Not an FRD requirement. If not built,
  merge items 1 and 2.
- **Free-tier agent limit**: if Free limits agents (open),
  the "Invite a teammate" item must reflect it in hosted mode.
- **Email setup completion**: this design uses "first inbound email
  received" as proof. If the provider offers a verification ping, that can
  replace it.
