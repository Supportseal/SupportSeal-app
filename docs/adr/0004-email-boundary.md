# ADR 0004 — Provider-neutral email boundary

Status: Accepted boundary; first hosted provider chosen 2026-09-26, then superseded by SendGrid on 2026-10-06 (comparison and decisions in [Supportseal/SupportSeal-app#3](https://github.com/Supportseal/SupportSeal-app/issues/3))
Date: 2026-09-25

## Decision

Normalise inbound mail and outbound delivery behind provider adapters. Correlate mail with a Product and Conversation using secure reply identifiers and validated threading headers, not subject text alone. Persist provider event IDs and outgoing results for idempotency and failure recovery.

## Why

Email is a V1 channel and self-hosters need a workable provider choice. Familiarity with SendGrid is useful but must not bind the product to one service.

## Consequences

Compare hosted provider candidates for inbound parsing, signatures, attachment limits, deliverability, local testing and cost before selecting one. Document at least one independent self-hosted inbound/outbound configuration. Never build a mail server.
