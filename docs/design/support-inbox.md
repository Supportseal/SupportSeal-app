# Support inbox — V1 design

Status: design direction for the build thread. Grounded in [PRD](../PRD.md)
(journeys 1–3), [FRD](../FRD.md) (FR-INBOX-01, FR-INBOX-02, FR-PROD-01,
FR-PROD-02, FR-CHAT-03, FR-EMAIL-03, FR-SEC-01) .

**UI kit:** the in-repo kit (`src/components`, `src/styles/tokens.css`; paths below are relative to `src/`). Colours only via `--vx-*` tokens. `ProductMark`,
`ProductChip`, `Skeleton`, `EmptyState` and `Sheet` are SupportSeal
additions (specified in `app-shell.md`; summarised here where used).

## Scope

The Conversation list pane: Product scope, status tabs, search, list rows,
realtime insertion, and the three-pane frame that hosts the Conversation
view. The thread, composer and context panel are in `conversation-view.md`;
the Product scope picker is in `product-switcher.md`.

## Layout

The inbox uses the shell's `fill` mode: full remaining height, no document
scroll.

```
xl (≥1280):  [ List 22.5rem ][ Thread (flex) ][ Context 20rem ]
lg (≥1024):  [ List 20rem   ][ Thread (flex) ]   Context = right Sheet
< lg:        List page  ──open──▶  Conversation page (back arrow)
```

Routes (proposal): `/inbox?product=<id>&status=open&q=<text>` and
`/inbox/<conversationId>?…` with the same query. The URL is the source of
truth for scope, status and search, so views can be shared, reloaded and
navigated with Back.

### List pane anatomy (top to bottom)

1. **Scope header** (h-12, `border-b`): current scope title, either
   "All Products" or the `ProductChip` of the selected Product, with a clear
   (×) button that returns to All Products. On `< xl` or with a collapsed
   sidebar, the title is the Product scope dropdown trigger
   (`product-switcher.md`).
2. **Search**: `Input` (`components/ui/input.tsx`, `size="sm"`) with a
   leading search icon. Placeholder: "Search conversations". `/` focuses it.
3. **Status tabs**: Open · Pending · Closed, each with a count; Open is
   the default. The theme's `TabsTrigger` (`components/ui/tabs.tsx`) is a
   solid primary pill, too heavy for a dense list. Add a `variant="underline"`
   size `sm`: text tabs with a 2px primary bottom border on active, counts
   in a `Badge` (`secondary`, `light`). Keep the Radix Tabs semantics.
4. **List**: independently scrolling `<ul>`, oldest conversation first
   (creation order on every tab; replies never reorder it, issue #199).
5. **Footer loader**: cursor pagination with a "Load more" button. It also
   auto-loads with an IntersectionObserver, and the button remains for
   keyboard and screen-reader users. Page size ~30. Do not use the theme
   `Pagination` component here.

### Row anatomy (≈ 76px, three lines)

```
[ProductMark] Contact label                        2m
              Last customer-visible message preview…
              [● Product name] [chat|mail icon] [tag] [tag] +2    [!]
```

- **Contact label**, in priority order: identified name (FR-CTX-01),
  email, then "Visitor" plus a short stable suffix (e.g. "Visitor 4F2A")
  for anonymous chats (FR-CHAT-02). Never show raw IDs.
- **Time**: relative ("2m", "3h", "Tue", "12 Mar"), with the absolute
  timestamp in `title` and inside a `<time datetime>`.
- **Preview**: last customer-visible message, one line, truncated. Agent
  replies are prefixed "You:" or "{Agent}:". Internal notes are never the
  preview. For email, prefer the subject when there is no body text yet.
- **Needs reply**: when the last customer-visible message is from the
  customer, the contact label is `font-semibold text-heading` and a 6px
  primary dot sits before the time. This is derived from message order, not
  per-agent read tracking (not specified in V1).
- **Product identity**: `ProductMark` (sm) at left **and** `ProductChip`
  in the meta line, on every row, including when filtered to one Product
  (FR-PROD-02). Archived Products use the archived chip style.
- **Channel**: Tabler `IconMessageCircle` (chat) / `IconMail` (email) with
  `aria-label`. A Conversation that has used both shows both icons
  (FR-INBOX-03).
- **Tags**: up to 2 small `Badge`s (`secondary`, `light`), then "+n".
- **Attention** `[!]`: `IconAlertTriangle` in danger when an outbound
  email failed to deliver (FR-EMAIL-03), tooltip "Reply not delivered".
- **Selected row**: `bg-primary-label` with a 3px primary inset left
  border. Hover: `bg-hover`.

### Behaviour

- **Scope filter** (FR-INBOX-01): Product scope comes from `?product=`.
  All Products shows every Product, archived ones included (history is
  preserved, FR-PROD-01). Changing scope keeps the status tab and clears
  the selection if the open Conversation falls outside the new scope.
- **Search**: runs server-side within the Workspace (FR-INBOX-01, FR-SEC-01)
  and within the current Product scope, **across all statuses**. While
  `q` is set, the status tabs are replaced by a "Results for 'x' · n" line
  with a clear button, and each row shows a status `Badge`. If the API
  returns a matched snippet, show it in place of the preview with the match
  in `<mark>`. Esc in the field clears the search. Debounce ~250ms and
  cancel stale requests.
- **Realtime** (FR-CHAT-03, ADR-0003):
  - A new or updated Conversation that matches scope and tab moves to the
    top. If the list is scrolled away from the top, don't shift rows under
    the pointer. Show a floating "n new" pill at the top of the list; clicking
    it scrolls to top and applies the update.
  - A Conversation that leaves the current tab after a status change (by
    you or another agent) animates out; if it was open, it stays open in the
    thread pane.
  - Counts in tabs and the sidebar update from the same events.
  - **Reopen** (maintainer, 2026-09-25): a reply to a Closed Conversation, from
    the customer (chat or email) or an agent, reopens that same Conversation
    as Open; no new Conversation is created. In the list it leaves Closed
    and appears at the top of Open like any other update.
- **Status change from the list**: none in V1 beyond keyboard shortcuts on
  the selected row (below); status actions live in the Conversation header.
  After a status change the next row is selected, and a `sonner` toast
  "Moved to Closed" offers **Undo** (restores the previous status).
- **Opening**: click or Enter opens `/inbox/<id>` in the thread pane
  (`≥ lg`) or as its own page (`< lg`). On `≥ lg` with no selection, the
  thread pane shows a quiet "Select a conversation" placeholder. Never
  auto-open the first row: that would hide the "needs reply" signal.

## Components

| Need | Source | Notes |
| --- | --- | --- |
| Search field | `components/ui/input.tsx` | `size="sm"`; icon via `InputGroup` (`components/ui/input-group.tsx`) or absolute icon |
| Status tabs | `components/ui/tabs.tsx` | Add `underline` variant, `sm` size |
| Counts, tags, status | `components/ui/badge.tsx` | `light` variant; Open=`primary`, Pending=`warning`, Closed=`secondary` |
| Tooltips | `components/ui/tooltip.tsx` | Channel/attention icons, collapsed marks |
| Errors | `components/ui/alert.tsx` | Inline list error |
| Spinner | `components/ui/spinner.tsx` | "Load more" busy state only |
| Toast | `sonner` | Undo after status change |
| Contact avatar | `components/ui/avatar.tsx` | Not in rows (ProductMark takes that slot); used in conversation header |
| Row skeleton | new `Skeleton` | Three bars matching row anatomy |
| Empty states | new `EmptyState` | See table below |
| Context sheet | new `Sheet` | Right-side panel at `lg` |

Do not use `components/tables/data-table.tsx`: a table layout is the
"Zendesk-style ticketing" feel the product deliberately avoids, and it is too
wide for a list pane.

## States

| State | What the list pane shows |
| --- | --- |
| Loading (first load) | 8 skeleton rows; tabs render with counts hidden |
| Loading (scope/tab/search change) | Keep old rows at 50% opacity with a thin top progress bar (`components/ui/progress.tsx` indeterminate, or a 2px animated bar); no layout jump |
| No Products (Admin) | `EmptyState` "Add your first Product" → onboarding Product step |
| No Products (Agent) | `EmptyState` "No Products yet. An admin needs to add one before conversations can arrive." |
| Products, no Conversations ever | `EmptyState` "Waiting for your first message", with actions "Install the widget" (Product settings → Widget) and "Send a test message" (onboarding test step) |
| Tab empty (Open) | "No open conversations." plus secondary text "New chats and emails will appear here." No celebratory illustration |
| Tab empty (Pending / Closed) | "No pending conversations." / "No closed conversations." |
| Search, no results | "No conversations match 'x' in {scope}." If scoped, add a button "Search all Products" |
| Scoped to an archived Product | Normal list plus a one-line `Alert` (`secondary`): "This Product is archived. New chats are blocked, incoming email bounces, and existing conversations are read-only." |
| List request failed | Inline `Alert` (`danger`) "Couldn't load conversations" with a Retry button. Keep previously loaded rows visible |
| Load-more failed | Replace the footer button with "Couldn't load more · Retry" |
| Realtime disconnected | Shell banner (app-shell). List keeps working and refetches on reconnect |
| Unknown `product` param | Treat as All Products and drop the param (no error, no leak) |

## Responsive

- `xl`: three panes. List 22.5rem, context 20rem, thread flexible
  (minimum ~28rem).
- `lg`–`xl`: list 20rem plus thread. Context opens as a right `Sheet` from
  a header button in the thread (`conversation-view.md`).
- `< lg`: the list is the page. Opening a Conversation navigates to a
  full-screen Conversation page with a back arrow that returns to the list
  with scroll position and filters intact (URL plus a stored scroll offset).
- `< sm`: row meta line hides tags beyond one; status tabs stay visible
  (three short labels fit at 320px).
- Touch: rows are at least 44px tall. No hover-only affordances.

## Accessibility

- List: `<ul aria-label="Conversations, {scope}, {status}">` of `<li>`
  containing one `<a>` per row. The row's accessible name is composed
  explicitly: "{contact}, {Product}, {channel}, {needs reply?}, {time},
  {preview}". The selected row has `aria-current="true"`.
- Keyboard: Tab reaches the list once. Inside it, ↑/↓ (and `j`/`k`) move
  focus between rows (roving `tabindex`), Enter opens, `/` focuses search,
  Esc returns focus from the thread to the selected row. Shortcuts are
  inactive while typing in inputs.
- Realtime additions are announced through a polite live region ("1 new
  conversation in Acme"), throttled to at most one announcement every
  ~10s. Don't make the list itself `aria-live`.
- Status is never colour-only: tab labels carry text, Needs reply adds
  font weight as well as the dot, and the failure icon has a label.
- Counts on tabs are exposed as text ("Open, 12").

## Not in V1

Assignment/"Mine" views, priority, SLAs, bulk selection and bulk actions,
saved views, tag filter, channel filter, sort options beyond creation order,
per-agent unread tracking, collision detection, snooze, cross-Product
Contact history, split inbox per agent, CSV export (PRD "Later").

## Decisions and defaults

See `docs/open-questions.md`, "Design decisions (2026-09-25)".

- **Reopen** (maintainer): a reply to a Closed Conversation reopens it; it is
  never a new Conversation and is not counted again for billing.
- **Archived Products** (maintainer): inbound email to an archived Product
  bounces. *Default:* existing Conversations stay readable in the list but
  are read-only; agents unarchive the Product to reply
  (`conversation-view.md`).

## Open points

- **Search fields**: which fields are searched (contact name/email, message
  bodies, email subjects, tags, context values) is a backend decision. The
  UI only needs an optional matched snippet.
- **Default status tab**: this design uses Open. If Pending means "waiting
  on customer", some teams want an Open+Pending combined view; not
  specified, so not built.
