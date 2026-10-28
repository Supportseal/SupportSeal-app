# App shell — V1 design

Status: design direction for the build thread. Grounded in [PRD](../PRD.md),
[FRD](../FRD.md) (FR-ACC-01, FR-PROD-02, FR-INBOX-01, FR-HOST-01, FR-USE-02).

## UI kit baseline (applies to every design doc)

- UI kit source: `src/components`, `src/styles/tokens.css`, `src/lib` and the
  `globals.css` token mapping. Paths below are relative to `src/`.
- Stack it assumes: Next.js App Router, React 19, Tailwind v4 (CSS-first),
  Radix primitives, Tabler icons, Plus Jakarta Sans, `next-themes`, `cmdk`, `sonner`.
- Colour: only through `--vx-*` tokens (`styles/tokens.css`, dark values on
  `.dark`). Product colours are data, never tokens (see "Product identity").
- Brand: SupportSeal, mint green. `brand.md` defines the palette, the
  replacement `--vx-*` token values (the kit's original placeholder violet primary
  is removed), the required component adjustments and the logo direction.
  `config/site.ts` `siteConfig.name = "SupportSeal"` is the single source
  of the product name.
- Root font size is 15px (`html { font-size: 15px }`); keep it for the
  dashboard. The chat widget must not depend on it.

## Scope

The authenticated frame around every dashboard page: navigation, header,
global search, availability control, account menu, Workspace-level banners,
and route-level loading/error handling. It does not cover the inbox panes
(see `support-inbox.md`, `conversation-view.md`) or the Product list in the
sidebar (see `product-switcher.md`).

## Layout

```
┌──────────────┬───────────────────────────────────────────────────┐
│ Logo         │ Header: [menu] [Search… Ctrl K] [Live▾] [theme] [me]│
│ Product list │───────────────────────────────────────────────────│
│ (switcher)   │ Banner slot (usage / connection / setup)          │
│──────────────│───────────────────────────────────────────────────│
│ Inbox        │ Main: "fill" mode (inbox) or "page" mode (settings)│
│ Saved replies│                                                   │
│ Settings ▸   │                                                   │
│──────────────│                                                   │
│ Setup 3/6    │                                                   │
└──────────────┴───────────────────────────────────────────────────┘
```

- **Sidebar** (`components/layout/sidebar.tsx`, width `--vx-sidebar-width`
  16.25rem, collapsed `--vx-sidebar-collapsed` 5.25rem, state persisted by
  `layout-provider.tsx`). Contents, top to bottom:
  1. Logo (links to `/inbox`).
  2. Product list — owned by `product-switcher.md`.
  3. Navigation, driven by a SupportSeal `config/menu.ts`:
     - **Inbox** (all roles).
     - **Saved replies** (all roles: Agents browse them; only Admins
       create, edit and delete them; each reply is available in All products
       or a selection of one or several Products, shown and filterable on the
       page).
     - **Settings** group: Workspace, Products, Team, Billing (hosted mode
       only), each Admin-only. Agents do not see Admin items; the server
       still enforces roles (FR-ACC-01, FR-SEC-01).
  4. Footer: onboarding checklist entry "Setup n/m" until complete or
     dismissed (see `onboarding.md`).
  Drop the theme's section labels except "Settings"; the menu is short.
- **Header** — adapt `components/layout/header.tsx`, but make it **flush**:
  `sticky top-0 h-header border-b border-border bg-surface`, no `mx-4`
  floating card, no `rounded-lg` (sealaudit `dashboard-shell.tsx` pattern).
  The floating card costs ~2rem of vertical space the inbox needs. Keep:
  mobile menu button, collapse toggle, search trigger, theme toggle, account
  menu. Remove: language button, shortcuts grid, notifications dropdown.
  Add: availability control (below).
- **Main** has two modes, chosen per route:
  - `page` (settings, onboarding checklist pages): scrolls with the
    document, `px-4 lg:px-6 py-6`, content `max-w-5xl`, uses
    `components/ui/page-header.tsx`.
  - `fill` (inbox, conversation): `h-[calc(100dvh-var(--vx-header-height))]`
    with `overflow-hidden`; each pane scrolls independently. No footer.
- Remove `components/layout/footer.tsx` from the authenticated shell.
- Default route: `/` redirects to `/inbox`. There is no dashboard/analytics
  home page (no "giant empty dashboards").

### Availability control (header)

Journey 4 requires that support can be set to away, and the widget switches
between live chat and an away message form (FR-CHAT-04). Availability is
**Workspace-wide** (maintainer, 2026-09-25): one manual Live/Away setting applies
to every Product's widget. The header shows a compact control: a status dot
plus the label "Live" (success) or "Away" (warning).

- **Admins** (default, see `docs/open-questions.md`): clicking opens a
  `DropdownMenu` (`components/ui/dropdown-menu.tsx`) with two
  `DropdownMenuCheckboxItem` options and one line of help text: "Away:
  visitors on all your Products leave a message and an email address; you
  reply by email." The change applies immediately to all widgets and shows a
  `sonner` toast.
- **Agents** see the same status as a non-interactive element with the
  tooltip "Only admins can change availability".
- The status updates live for every signed-in user when an Admin changes it.
- There are no schedules or per-Product overrides in V1.

### Global search (Ctrl/Cmd+K)

Reuse `components/layout/search-command.tsx` (Radix `Dialog` + `cmdk`),
extended with three groups: **Conversations** (server search, debounced
~200ms, Workspace-scoped per FR-INBOX-01; each result shows the Product
chip, contact label and matched snippet), **Products** (sets the inbox
scope) and **Pages** (settings routes filtered by role). The header trigger
text becomes "Search conversations…" with a `Ctrl K` / `⌘K` hint.

### Banner slot

A single stacked region above main content, using `components/ui/alert.tsx`:

- **Usage** (hosted, Admins only, FR-USE-02): `warning` when the allowance is
  close or exceeded and the grace period is active; `danger` when the grace
  period is ending. Always says new customer messages are still accepted,
  and links to Billing. Agents see nothing. Never shown in self-hosted mode
  (FR-HOST-01).
- **Realtime connection**: after about 5s without a stream, show an `info`
  alert "Reconnecting… new messages may be delayed". Clear it silently on
  recovery. Never block the UI; sending still uses normal requests
  (ADR-0003).
- **Setup**: not a banner; see `onboarding.md`.

### Product identity primitives (shared, built here)

Product identity must be visible in every inbox view (FR-PROD-02), so the
shell provides:

- `ProductMark`: 20px (sm) / 28px (md) rounded square in the Product
  colour, containing the Product's first letter. Text is black or white,
  whichever gives the higher WCAG contrast, computed from the hex value.
  Add a 1px inset `--vx-border` ring so near-white colours stay visible.
- `ProductChip`: mark or 8px dot plus the Product name in `text-heading`.
  Never render text in the Product colour: colour is arbitrary user data and
  cannot guarantee contrast.
- Archived Products: chip at 60% opacity with a trailing "Archived"
  `Badge` (`components/ui/badge.tsx`, `secondary`, `light`).

### Auth pages

Use `app/(auth)/layout.tsx`, simplified to a centred card: drop the
illustration panel and its template copy (marketing is out of V1). Pages:
sign in, register, forgot/reset password, accept invite (ADR-0002). In
self-hosted mode, registration is available only until the single Workspace
exists. After that `/register` shows "Registration is closed. Ask your
administrator for an invitation." (maintainer: multi-Workspace self-hosting is
blocked).

## Components

| Need | Source | Notes |
| --- | --- | --- |
| Shell frame | `components/layout/app-shell.tsx`, `layout-provider.tsx` | Add `mode: "page" \| "fill"`; drop footer |
| Sidebar | `components/layout/sidebar.tsx`, `config/menu.ts` | Replace menu; mobile drawer change below |
| Header | `components/layout/header.tsx` | Flush variant; strip demo menus |
| Search | `components/layout/search-command.tsx` | Add Conversations/Products groups |
| Logo | `components/layout/logo.tsx` | SupportSeal mark; name from `siteConfig` |
| Menus | `components/ui/dropdown-menu.tsx` | Availability, account |
| Avatar | `components/ui/avatar.tsx` | Account menu (initials) |
| Banners | `components/ui/alert.tsx` | Usage, connection |
| Tooltip | `components/ui/tooltip.tsx` | Collapsed nav labels |
| Toasts | `sonner` `Toaster` in `app/layout.tsx` | Keep theme styling and `top-right`, offset by `--vx-header-height`, so toasts never cover the composer |
| Error/404 | `app/error.tsx`, `app/not-found.tsx` | Route-level `error.tsx` renders inside the shell |

To build (theme gaps, same conventions: `cva`, `cn`, Radix, tokens):
`Sheet` (Radix Dialog anchored left/right), `Skeleton` (pulse bar, as in
sealaudit `dashboard-section-skeleton.tsx`), `EmptyState` (icon, title, one
line, primary action), `Kbd`, `ProductMark`, `ProductChip`.

## States

| State | Behaviour |
| --- | --- |
| Loading (route) | Route `loading.tsx` keeps sidebar and header, renders `Skeleton` in main |
| Signed out / session expired | Redirect to sign-in with `returnTo`; after sign-in return there |
| No Workspace access | Full-page "You don't have access to this Workspace" with a sign-out button. No data or names leak (FR-SEC-01) |
| Admin page opened by an Agent | In-shell "Only Workspace admins can open this page" `EmptyState` |
| Route error | In-shell error panel ("Something went wrong", Retry = `reset()`); never a raw stack trace |
| Offline (`navigator.onLine` false) | Connection banner says "You're offline" |
| Hosted over allowance | Usage banner (Admins) |

## Responsive

- `≥ lg` (1024px): fixed sidebar, collapsible to icons; the collapsed
  preference persists (`vx-sidebar-collapsed` in localStorage).
- `< lg`: sidebar becomes an off-canvas drawer opened from the header menu
  button. Implement it with the new `Sheet` (Radix Dialog), not the theme's
  plain overlay `div`, so focus is trapped, Esc closes and scroll locks.
  The drawer closes on navigation (existing `useEffect` on `pathname`).
- `< sm`: the header search trigger collapses to an icon button; the
  availability control shows only the dot plus a short label.
- Use `100dvh` for fill mode so mobile browser chrome doesn't cut off
  composers.

## Accessibility

- Landmarks: `<nav aria-label="Main">`, `<header>`, `<main id="main">`, and
  a "Skip to content" link as the first focusable element.
- Active nav link: `aria-current="page"`. Collapse toggles get
  `aria-expanded` and `aria-controls`. Collapsed icons keep accessible names
  (Tooltip plus `aria-label`).
- Keep the theme's global `*:focus-visible` outline. Never remove outlines
  without replacing them.
- Availability control: for Admins, a button labelled "Support
  availability: Live"; for Agents, the same text as a status element. The
  status is never conveyed by colour alone.
- Honour `prefers-reduced-motion`: disable sidebar width and drawer
  transitions.
- Document keyboard shortcuts in a `?` help dialog. V1 shortcuts:
  `Ctrl/⌘K` search, `/` focus inbox search, plus inbox/conversation keys
  from those docs.
- Full WCAG AA hardening is V2. V1 must not ship primitives
  that are knowingly inaccessible.

## Not in V1

Workspace switcher (one Workspace per user; self-hosting is single-Workspace
by decision) · notification centre · language switcher · horizontal or
customisable layouts · analytics dashboard home · agent presence list ·
audit log page · marketing pages and Umami (out of V1 by decision).

## Decisions and defaults

See `docs/open-questions.md`, "Design decisions (2026-09-25)".

- **Availability** is Workspace-wide and manual (maintainer). *Default:* only
  Admins can change it.
- **Saved replies**: *default:* all roles insert them; only Admins manage
  them.
- **Brand**: SupportSeal, mint green (maintainer); tokens and logo in `brand.md`.
