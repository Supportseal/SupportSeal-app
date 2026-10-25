# Desktop notifications

Agents can opt in from the account menu → **Desktop notifications**. The
preference applies to the current user, workspace and browser. Permission is
requested only on that click. Switching off stops the listener and clears
its queued alerts. Denied permission and unsupported browsers show guidance.

- Requires a supported desktop browser, HTTPS (localhost is also allowed),
  Web Locks and browser storage. No extra server configuration is needed.
- Works while a dashboard tab is open, including background tabs. Closing
  all dashboard tabs stops delivery; this is not Web Push or offline delivery.
- Alerts cover incoming **customer** messages in new and existing chat/email
  conversations, across the workspace's products. Agent replies, notes and
  status updates never generate notifications. Initial opt-in skips history.
- The first detected arrival notifies immediately. Further arrivals within
  60 seconds are grouped into a trailing summary, even if no more arrive.
  Multiple tabs share the throttle and cursor under a Web Lock.
- A conversation actively viewed in a focused tab is suppressed. Notification
  text contains the configured brand and generic counts, never customer names
  or message bodies. Clicking opens the conversation, or the inbox for a batch.

## Delivery and verification

The authenticated `/api/inbox/notifications` feed reads durable CUSTOMER rows
scoped to the current membership. A timestamp + message ID cursor handles
pagination when messages share a timestamp. Responses are private/no-store
and include the user/workspace identity so stale tabs cannot consume another
signed-in account's feed. Notification failures retain the cursor for retry.

The existing inbox SSE listeners wake the notification listener locally and
across tabs. All dashboard pages also poll every 30 seconds. Browsers can
suspend or throttle background tabs, so delivery is best-effort and may be
late. A listener resuming after no successful poll for two minutes baselines
history on mount, rather than replaying an offline backlog. This is a
notification aid, not an unread-message ledger or guaranteed delivery system.

Tests cover customer-only/tenant-scoped feeds, cursor pagination, cross-tab
deduplication, batching, focused-thread suppression, failures and opt-out.
