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
| First chat action by a new visitor (message, email, upload, identify) | once per browser that actually uses the chat | inserts one `chat_visitors` row |
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
- **Visitor writes are throttled and merged.** Resolving a visitor session
  (which every widget request does) refreshes `lastSeenAt` at most every 10
  minutes (30 s with `REALTIME_DB_POLL` on). The exceptions are visitor
  actions: each message send and each email capture still sets `lastSeenAt`,
  now in the same write as the page URL or email instead of a second
  `UPDATE`.

- **Workspace availability is cached with the Product lookups.** Every
  widget boot reads the Workspace's Live/Away availability; it is cached
  under `availability:<workspaceId>` in the same cache, and `setAvailability`
  (the only writer, `src/lib/workspace.ts`) clears it. A test fails if an
  availability write appears anywhere else. The pause check already had its
  own short "not paused" cache (`src/lib/service-pause.ts`).
- **Visitor rows are created on first use.** The panel boots with
  `x-ss-defer-session: 1`: a browser with a valid visitor session resumes it
  as before, but a browser without one gets the widget's config and an empty
  thread and no `chat_visitors` row. The row is created by the panel's first
  chat action: sending a message, saving an email, uploading a file, or an
  `identify` call from the host page (a signed-in user keeps one session, so
  that is one row per person). Context data alone waits in the panel's queue
  until a session exists. Browsers that
  never use the chat no longer insert a row or spend the per-IP session mint
  budget.

## Remaining options (not done)

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

**Baseline, 2026-11-16 07:30 UTC** (before the caches). Postgres 18 on the
Coolify server, counters since the move from Neon at 02:45 UTC (about 4 h 45
min; inserts include the restore). One app container, one server process,
`REALTIME_DB_POLL=off`. Tables with more than 50 scans:

| Table | Seq scans | Index scans | Inserts | Updates | Deletes | Live rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| products | 1,440 | 0 | 21 | 0 | 0 | 21 |
| product_domains | 1,227 | 0 | 43 | 0 | 0 | 43 |
| workspaces | 815 | 0 | 3 | 1 | 0 | 3 |
| chat_visitors | 11 | 764 | 26,689 | 242 | 0 | 26,689 |
| conversations | 20 | 232 | 244 | 5 | 0 | 244 |
| messages | 8 | 203 | 652 | 0 | 0 | 652 |
| widget_host_signals | 7 | 112 | 235 | 34 | 0 | 235 |

Widget Product lookups (about 5 a minute, every one a sequential scan of a
21-row table) dominate. Dashboard polling was light in this window.
`chat_visitors` has never been purged on hosted: no Coolify scheduled task,
host cron or timer runs the purge script. The app does not log requests, so
per-path counts would need the proxy's access log.

**After PR #109** (deployed 07:52 UTC, same single container throughout).
Before = the 22.7 minutes from the baseline to the deploy on the old image;
after = the following 61.5 minutes on the new image. Both scaled to an hour:

| Table | Before / h | After / h | Change |
| --- | ---: | ---: | ---: |
| products (scans) | 645 | 162 | −75% |
| product_domains (scans) | 559 | 74 | −87% |
| workspaces (scans) | 349 | 303 | not cached yet |
| chat_visitors (inserts) | 77 | 65 | unchanged by design |
| chat_visitors (updates) | 93 | 45 | −52% |

Widget traffic was the same in both hours (from the proxy access log: about
120 each of `GET /api/widget/config`, `GET /widget` and `POST
/api/widget/session`, and about 60 `GET /api/widget/messages` per hour), so
the drop comes from the cache, not from fewer requests. The remaining
Product scans are cache refills after each 30 s expiry plus dashboard pages.
`conversations` and `messages` rose in the after hour only because someone
used the dashboard then (38 inbox page views, none in the hour before).
`workspaces` is now the busiest table: the availability and pause reads on
widget boot were the next candidate. Fresh visitor rows (about 70 an hour,
one per widget boot without a saved session) were the other. Both are
addressed by the follow-up PR (availability cache, visitor rows on first
use); see What keeps it small.
