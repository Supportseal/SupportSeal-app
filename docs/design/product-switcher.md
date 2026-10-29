# Product switcher — V1 design

Status: design direction for the build thread. Grounded in [PRD](../PRD.md)
(principle "Keep Product identity obvious without fragmenting the support
team's workflow"; journey 2), [FRD](../FRD.md) (FR-INBOX-01, FR-PROD-01,
FR-PROD-02, FR-ACC-01) .

**UI kit:** the in-repo kit (`src/components`, `src/styles/tokens.css`; paths below are relative to `src/`). Colours only via `--vx-*` tokens.

## Scope

How an agent moves between "All Products" and one Product, and back, and how
Product identity (name plus colour) is drawn consistently. The switcher is
an **inbox scope filter, not a context switch**: it never changes Workspace,
permissions or settings pages. It writes the inbox `?product=` parameter
(`support-inbox.md`).

## Product identity primitives

Every Product surface uses the same two primitives (built once in the app
shell; restated here so this doc stands alone):

- **`ProductMark`**: rounded square (`rounded-md`), 20px (sm) or 28px (md),
  filled with the Product's primary colour and showing the first letter of
  the Product name. The letter is black or white, whichever has the higher
  WCAG contrast ratio against the fill, computed from the hex value. A 1px
  inset ring in `--vx-border` keeps near-white colours visible on the
  white surface and near-black ones visible in dark mode.
- **`ProductChip`**: 8px colour dot (or sm mark) plus the Product name in
  `text-heading`. **Never** set text in the Product colour: it is arbitrary
  customer data and can fail contrast in either theme.
- Two Products with the same colour and initial remain distinguishable by
  name. Colour is reinforcement, never the only signal.
- Archived: 60% opacity plus a `Badge` "Archived" (`components/ui/badge.tsx`,
  `secondary`, `light`).
- Logos/avatars are V2. The mark is deliberately letter-based.

## Entry points

The switcher appears in three places, sharing one data source: active
Products with Open counts, loaded once per session and kept current by
realtime events.

### 1. Sidebar Product list (primary, `≥ lg`, expanded sidebar)

Placed directly under the logo, above the nav (`components/layout/sidebar.tsx`
slot). Styled like theme nav links (`text-[0.9375rem]`, `rounded-md px-3
py-2`, active = `bg-primary-label text-primary`; the theme's solid-primary
active pill is too loud for a list the user scans constantly):

```
INBOX
  ▣ All Products          24
  A  Acme Analytics        12
  B  Beacon Forms           9
  L  Lumen Docs             3
  + Add Product                (Admin only)
```

- "All Products" is always first and is the default.
- Products with Open Conversations come first, then the rest, each group
  A–Z (the busy Products are the ones an agent wants within reach). Only
  **active** Products are listed; archived ones live in the dropdown (entry
  point 2).
- Count = Open Conversations for that Product, as a right-aligned plain
  number in `text-muted`, bold when non-zero. It does not mean "unread";
  per-agent unread isn't specified in V1. Zero shows nothing.
- Clicking navigates to `/inbox?product=<id>` (keeping the current status
  tab). Selecting from a non-inbox page (e.g. settings) also navigates to
  the inbox.
- Every active Product is listed. The Product list is its own scrollable
  region, so the main nav and Settings links stay in place. With more than
  8 active Products a "Filter products" input (client-side, case-insensitive
  substring match) appears above the list; "Add Product" stays pinned below
  it.
- "Add Product" (Admin only) opens the new-Product flow
  (`product-settings.md`). Agents don't see it.
- **Collapsed sidebar**: each entry becomes its `ProductMark` (md), centred,
  with a `Tooltip` (`components/ui/tooltip.tsx`) "{name} · {n} open" and a
  small count dot. "All Products" becomes a stacked-squares icon
  (`IconStack2`).

### 2. Scope dropdown (list-pane header; primary on `< lg` or collapsed)

The inbox list-pane title is a button: "All Products ▾" or the selected
`ProductChip ▾`. It opens a `Popover` (new wrapper over
`@radix-ui/react-popover`, already a theme dependency) containing a `cmdk`
list styled like `components/layout/search-command.tsx`:

- A filter input "Find a Product" (auto-focused; shown when there are more
  than 5 Products).
- All Products → active Products (mark, name, count) → an "Archived (n)"
  group, collapsed by default. Archived Products stay selectable because
  their history remains readable (FR-PROD-01).
- Footer links: "Manage Products" (Admin → `/settings/products`).
- Next to the title, a clear (×) button whenever a Product is selected:
  one click back to All Products.
- On `< sm` the Popover renders as a bottom `Sheet` for thumb reach.

### 3. Global search (Ctrl/⌘K)

The command palette (`components/layout/search-command.tsx`) includes a
**Products** group. Selecting a Product sets the inbox scope. Typing a
Product name therefore gives a keyboard-only switch from anywhere.

### Keyboard

- `g` then `a`: All Products. `g` then `1`–`9`: nth Product in sidebar order.
  List these in the `?` shortcuts dialog. They are inactive while typing.

## Behaviour rules

- The URL (`?product=`) is the source of truth. The last scope is
  remembered in localStorage, so a bare `/inbox` restores it, **except**
  right after a Product is created, which scopes to All Products so the
  user sees both Products together (the "second aha").
- Changing scope keeps the status tab and search, and closes an open
  Conversation that is outside the new scope.
- If the scoped Product is archived or deleted by someone else: archived →
  stay, and show the archived notice in the list; deleted → fall back to
  All Products with a toast "{name} was deleted".
- An unknown or unauthorised Product ID in the URL silently becomes All
  Products (no error that could confirm existence; FR-SEC-01).
- Counts and list update from realtime events; on reconnect, refetch the
  counts.

## Components

| Need | Source | Notes |
| --- | --- | --- |
| Sidebar slot and link styling | `components/layout/sidebar.tsx` (`NavLink` classes) | Softer active style (label, not solid) |
| Collapsed tooltips | `components/ui/tooltip.tsx` | |
| Dropdown list | `cmdk` (as in `components/layout/search-command.tsx`) + new `Popover` | |
| Mobile sheet | new `Sheet` (Radix Dialog) | `< sm` |
| Archived badge | `components/ui/badge.tsx` | |
| Icons | `@tabler/icons-react` `IconStack2`, `IconPlus`, `IconX`, `IconChevronDown` | |
| Identity | new `ProductMark`, `ProductChip` | Contrast helper in `lib/` |

## States

| State | Behaviour |
| --- | --- |
| Loading | 3 skeleton rows in the sidebar list; the dropdown trigger shows "All Products" (safe default) |
| No Products (Admin) | Sidebar shows only "+ Add your first Product" (primary text link); the dropdown shows the same |
| No Products (Agent) | Sidebar list hidden; the inbox empty state explains that an admin must add a Product |
| One Product | Still show "All Products" plus the one Product (scope stays meaningful when the second arrives) and a subtle "+ Add Product" for Admins |
| Count fetch failed | Hide counts, keep navigation working; retry on the next realtime event or after 30s |
| Filter no match | "No Products match 'x'" |

## Responsive

- `≥ lg` expanded: sidebar list (entry 1), plus dropdown title in the list pane.
- `≥ lg` collapsed: marks with tooltips, plus dropdown.
- `< lg`: the sidebar is a drawer, so the Product list is also in the
  drawer, but the list-pane dropdown is the main control; `< sm` uses the
  bottom sheet.

## Accessibility

- Sidebar list: `<nav aria-label="Products">` with links; the active scope
  has `aria-current="page"`. Each link's name includes the count: "Acme
  Analytics, 12 open".
- The dropdown trigger has `aria-haspopup="listbox"` and
  `aria-expanded`; cmdk provides combobox/listbox roles. Esc closes it and
  returns focus to the trigger.
- The clear (×) button: `aria-label="Show all Products"`.
- `ProductMark` is `aria-hidden` wherever the name is also rendered; in
  collapsed mode the link carries `aria-label`.
- The contrast helper guarantees ≥ 4.5:1 for the mark letter where possible.
  For mid-tone colours where neither black nor white reaches it, pick the
  higher one; the name text beside the mark carries the meaning.

## Not in V1

Per-Product dashboards or analytics · Product groups/folders · drag-to-reorder
or pinning · per-agent Product membership or visibility (everyone with
Workspace access sees all Products, FR-PROD-02) · Product logos/avatars
(V2) · Workspace switching (single Workspace per user; self-hosting is
single-Workspace by decision) · multi-select Product filters · per-Product
availability indicators (availability is Workspace-wide, per the maintainer
2026-09-25; the header control in `app-shell.md` covers it).

## Open points

- **Count meaning**: Open count is used because "unread" isn't a V1
  concept. If the maintainer wants "needs reply" counts instead, the data source
  changes but the UI doesn't.
