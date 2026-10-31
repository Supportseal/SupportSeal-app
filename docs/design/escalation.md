# Unanswered-request escalation — design

Covers FR-INBOX-05. When a new support request (live chat or inbound email)
has had no agent reply for the Product's wait time, every Workspace admin
gets one email with the customer's messages and a link to the Conversation.

## Behaviour

- **Unanswered** means: status Open, no AGENT Message (internal notes do not
  count), at least one customer Message, Product not archived. Closing or
  replying counts as handled.
- **Once per Conversation.** `conversations.escalatedAt` is set by a single
  conditional UPDATE that re-checks the unanswered predicate (the "claim"),
  then the mail is sent. Concurrent sweeps, several app instances and an agent
  reply landing as the timer fires cannot double-send or send after a reply.
  If every send fails the claim is released and the next sweep retries; a
  crash between claim and send loses that one alert (at-most-once wins over
  duplicates).
- **Email body:** every customer Message in the Conversation, oldest first,
  each with its UTC send time (empty Messages are skipped). Each Message is
  capped at 2,000 characters; the email shows at most 20 Messages and about
  10,000 characters in total, then ends with "(+N more messages in the
  Conversation.)". The subject is the email subject or the first message.
- **Settings** (per Product, Admin-only, Product → Email): enable switch
  (default on) and wait time in minutes (default 20, range 5–1440). One value
  covers chat and email. The card shows a note when the server has no outbound
  mail provider.
- **Recipients:** all Workspace admins (see `open-questions.md` E2).
- **No provider configured:** the sweep no-ops without claiming anything, so
  requests still escalate once mail is configured. Requests more than 24 h
  past their threshold are treated as stale and never escalated.

## Triggering (no background worker)

All three entry points call the same idempotent `sweepEscalations()`:

1. **Lazy sweep** — at most once a minute per process, started by customer
   message intake and inbox loads.
2. **In-process timer** — armed (unref'd, one per Conversation) when a
   customer message lands on an unanswered Conversation, so an idle
   self-hosted server escalates on time. Lost on restart; 1 and 3 cover that.
3. **`POST /api/internal/escalations/sweep`** with
   `Authorization: Bearer $CRON_SECRET` (404 when `CRON_SECRET` is unset).
   Optional; point a scheduler (e.g. a Coolify scheduled task running
   `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" $APP/api/internal/escalations/sweep`
   every minute) at it for tight latency on a quiet server.
