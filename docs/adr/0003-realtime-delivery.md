# ADR 0003 — Durable messages and event-stream delivery

Status: Accepted 2026-09-26 — validated by the two-process reverse-proxy spike; measurements, findings and the accepted follow-ups are recorded in [Supportseal/SupportSeal-app#2](https://github.com/Supportseal/SupportSeal-app/issues/2#issuecomment-5847092915)
Date: 2026-09-25

## Decision

Persist messages before notifying clients. Deliver server-to-client changes over SSE with resumable cursors; submit messages by normal HTTP request. Use database-backed event coordination initially, with a bounded polling fallback on disconnect. Do not add Redis by default.

## Why

Chat needs timely delivery and reconnection, but does not initially need bidirectional socket state or an extra service for self-hosting.

## Consequences

The spike proved ordered resume, at-least-once delivery (clients dedupe by message id), unbuffered SSE through stock reverse proxies via the existing `x-accel-buffering: no` header (proxies must not gzip `text/event-stream`), and two-process fan-out bounded by the database polls (2 s widget, 10 s inbox). Accepted follow-ups from the spike: seed the inbox poll baseline at connect, warn at boot when the database clock or session timezone is not UTC-aligned (external databases must run `timezone=UTC`), and document the proxy gzip constraint. PostgreSQL `LISTEN`/`NOTIFY` (~4 ms measured) remains the measured upgrade path if the poll bounds ever feel slow; polling stays the fallback either way.

## Scaling notes (desk inbox stream)

`/api/inbox/stream` is Workspace-isolated: the Workspace comes from the authenticated membership and every delivery path (in-process bus and the cross-process poll) is filtered by it; `inbox-stream.test.ts` asserts that a second Workspace never receives the first one's events. Its **cost**, however, scales with open connections rather than with changes:

- The in-process bus is one global emitter; each connection's listener receives every Workspace's events and discards the others (O(connections) per event; Node's listener cap is raised to 200 and only warns beyond it).
- Each connection runs its own 10 s `findMany` signature poll, so idle load is `connections / 10 s` queries, and each browser tab holds two connections (list pane + conversation view, #118).

This is acceptable for a handful of tenants and is the known limit for hundreds. The planned fix keeps these guarantees and changes only the shape: per-Workspace event routing and a single process-level poller fanned out per Workspace, specified in [#7](https://github.com/Supportseal/SupportSeal-app/issues/7). `LISTEN`/`NOTIFY` remains a separate decision.

Client side (`src/lib/inbox-stream-client.ts`): the stream sends `heartbeat` as a named event every 15 s; the client reconnects after 45 s of silence, or with jittered exponential backoff (1 s to 30 s) when the browser gives up, and refetches once the stream is back, because events may have been missed while it was down.
