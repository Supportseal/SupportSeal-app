# Database load

What makes the app talk to its database while nobody is doing anything, what
we measured on the hosted tier, and what keeps that work small. Read this
before adding anything that polls or runs on a timer. Earlier work on the
same problem: [ADR 0003's 2026-11-02 update](adr/0003-realtime-delivery.md)
(PR #75: `REALTIME_DB_POLL=off`, parked widget streams, throttled
`ChatVisitor.lastSeenAt`).

## Where the steady load comes from

Traffic on the hosted tier is small (243 conversations by mid-November
2026), so almost all database work is background work by open browser tabs:

| Source | Cadence | Tables it reads or writes |
| --- | --- | --- |
| Dashboard tab: page-title and unread counts (`/api/inbox/unread`) | every 15 s per tab, hidden tabs too | `sessions`, `users`, `memberships`, `messages`, `conversations`, `message_read_receipts` |
| Dashboard tab: message sound (`/api/inbox/notifications`) | every 20 s per tab unless muted | `sessions`, `users`, `memberships`, `messages`, `conversations` |
| Dashboard tab: desktop notifications (same feed) | every 30 s per tab, only with notifications on | same |
| Widget on any page (marketing site, dashboard sign-in and settings) | each request: panel, session boot, config, stream connect, messages | `products`, `product_domains`, `chat_visitors`, `workspaces` |
| Widget session boot without a saved session | once per page load in a browser without a usable visitor cookie | inserts one `chat_visitors` row |
| Realtime streams with `REALTIME_DB_POLL` on | every 2 s per open widget, 10 s per open inbox | `messages`, `conversations` |

The hosted compose file sets `REALTIME_DB_POLL=off` (one app process), so the
last row only applies to multi-process deployments.

## What keeps it small

- **Product lookups are cached in memory** (`src/lib/product-lookup-cache.ts`).
  Every widget and form request starts by resolving its public key to a
  Product and its allowed domains. Hits are kept for 30 s; every Product or
  domain write goes through `src/lib/products.ts`, which clears the cache, so
  edits, key rotations and archiving apply at once in a single process (and
  within 30 s on another process). Misses are never cached. A test fails if
  a Product or domain write appears anywhere else.
- **Dashboard poll answers are cached until something changes**
  (`src/lib/inbox-attention-cache.ts`). The unread count, open-conversation
  count and newest customer message are cached per Workspace and dropped on
  the next conversation event for that Workspace (every message write and
  status change emits one) or read receipt. Polls keep their cadence, so open
  tabs update exactly when they did before, but an idle poll costs only the
  session check. Active only with `REALTIME_DB_POLL=off`: with several
  processes another process's writes never reach this one's event bus.
- **Visitor writes are throttled and merged.** `lastSeenAt` is refreshed at
  most every 10 minutes (30 s with `REALTIME_DB_POLL` on); sending a message
  or capturing an email updates it in the same write as the page URL or email
  instead of a second `UPDATE`.

## Remaining options (not done)

- **Lazy visitor sessions.** The panel boots a session, and so inserts a
  `chat_visitors` row, on every page load for a browser without a visitor
  cookie, even if the chat is never opened. Creating the row on first use
  (message, email, upload, identify) would cut both the inserts and the
  table size by roughly the ratio of page views to chats. Larger change to
  the panel; needs its own PR.
- **Session cookie cache.** Every dashboard poll still checks the session
  in `sessions` and `users`. better-auth's `session.cookieCache` would skip
  that for a short `maxAge`, at the cost of a sign-out on another device
  taking up to `maxAge` to apply. A security trade-off for the maintainer.
- **Scheduled visitor purge.** `scripts/purge-stale-visitors.ts` is manual
  (see [self-hosting.md](self-hosting.md)) and nothing runs it on hosted. The
  app image does not carry the script, so a Coolify scheduled task needs
  either the migrate image or a `CRON_SECRET`-gated purge endpoint like the
  escalation sweep.

## Measuring

`pg_stat_statements` is not installed on hosted. Two snapshots of
`pg_stat_user_tables` an hour apart give per-table scans and writes; compare
them with the request log for the same hour:

```sql
SELECT relname,
       seq_scan + coalesce(idx_scan, 0) AS scans,
       n_tup_ins + n_tup_upd + n_tup_del AS writes,
       n_tup_ins, n_tup_upd, n_tup_del, n_live_tup
FROM pg_stat_user_tables
ORDER BY scans DESC;
```

## Hosted measurements

<!-- filled in from the snapshots below -->
