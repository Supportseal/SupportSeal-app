# New-message email alerts for agents — design

Covers FR-ALERT-01. Agents hear about new customer messages through the
in-tab notification and sound while a dashboard tab is open. When nobody is
looking, each member gets an email instead. Slack and Discord are out of
scope (maintainer, 2026-11-22). Defaults: open-questions.md AA1–AA5.

## Behaviour

- **What triggers it:** a CUSTOMER Message (widget chat, contact form,
  inbound email) that is still unanswered `AGENT_ALERT_DELAY_MS` (2 minutes)
  after it arrived. Internal notes do not count as an answer; an AGENT
  Message at or after the newest alerted message does. Closed Conversations
  and archived Products are skipped.
- **Who gets it:** every Workspace member whose own preference is on for
  that kind (new Conversation or customer reply), except a member who has
  a dashboard open (a live `/api/inbox/stream` connection in this process,
  `src/lib/dashboard-presence.ts`) or has read every Message in the batch
  (read receipts, FR-INBOX-04).
- **Kinds:** *new conversation* when no customer or agent Message precedes
  the batch, otherwise *customer reply*. Subjects:
  `[Product] New: <subject or first line> (SS-12)` and
  `[Product] Reply from <name> (SS-12)`. The body is the batch's messages
  (same caps as the escalation email), a dashboard link and a link to
  Settings → Notifications.
- **Batching:** the sweep claims every unclaimed customer Message of a
  Conversation whose oldest one is due, so a burst becomes one email.
- **At most once:** `messages.agentAlertedAt` is set by one conditional
  UPDATE (the claim) before anything is sent. If every send for a batch
  fails the claim is released so the next sweep retries. A batch more than
  6 hours past due is claimed but not emailed (stale).
- **No provider:** the sweep no-ops without claiming; Settings → Notifications
  says alerts cannot be sent.
- **Escalation stays:** the 20-minute admin escalation (FR-INBOX-05) is a
  separate, later "still nobody answered" email.

## Triggering (no background worker)

Same three entry points as the escalation sweep, all calling the idempotent
`sweepAgentAlerts()`:

1. **In-process timer**, armed once per Conversation when a customer Message
   lands; fires 2 minutes later. Lost on restart.
2. **Lazy sweep**, at most once a minute per process, from message intake.
3. **`POST /api/internal/escalations/sweep`** (with `CRON_SECRET`) also runs
   it and reports `agentAlerts` in its response.

Nothing polls the database on a schedule, and an open dashboard tab writes
nothing: presence is an in-memory counter per membership.

## Settings

Settings → Notifications (`/settings/notifications`), visible to every
member: two switches, "New conversations" and "Customer replies", stored on
the member's own Membership (`emailOnNewConversation`,
`emailOnCustomerReply`, default true). A member can only change their own.
