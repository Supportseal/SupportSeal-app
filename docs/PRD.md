# Product requirements

## Purpose

Give people who build several independent products one place to handle customer support, with enough application context to answer well. A Workspace contains Products; each Product has its own customer-facing identity and support channels; the team works from one inbox.

## Audience and problem

The primary users are indie developers, bootstrapped SaaS founders and small software teams with multiple products. Their support is scattered across product inboxes, chat tools and accounts. Generic support tools often lack the account and application details a developer needs to resolve an issue.

## Product promise

One support desk for everything you build: live chat and support email for each Product, a unified inbox, useful developer context, and a choice between managed hosting and genuine self-hosting from the same source.

## Domain model

**Workspace → Product → Conversation.** A Workspace is the team/account and can hold unlimited Products. A Product is one independent SaaS, site, app or tool — possibly unrelated to the others — and owns its identity, domains, widget, support email and developer context; it is not merely an inbox. A Conversation is one customer interaction over chat or email. The interface says "Conversation", not "ticket", and stays conversational rather than Zendesk-style. Each Conversation does carry a short per-Workspace reference number (for example `SS-123`, FR-INBOX-06) that customers and agents can quote; it is shown as a plain reference, not as ticket-queue machinery. V1 users belong to one Workspace, but the schema must allow multi-Workspace membership later without destructive changes.

## Differentiation

Not another Intercom alternative, generic open-source help desk or chat widget. The combination is what matters: portfolio-first support, first-class inbound email per Product, developer/application context on every Conversation, low-friction setup and integration, free self-hosting, managed hosting for those who prefer it, and premium UX. Positioning detail lives in [product-positioning.md](product-positioning.md).

## Principles

- Make the first real customer message easy to receive; make the second Product easy to add.
- Keep Product identity obvious without fragmenting the support team's workflow.
- Support asynchronous replies as well as live chat; founders are not online around the clock.
- Let developers provide intentional context without automatic collection of sensitive application data.
- Charge hosted customers primarily for support volume, without a per-Product tax or paid per-agent pricing.
- Keep self-hosting viable without a dependency on the managed service, hosted billing or proprietary authentication.
- Publish the core under AGPLv3 (see LICENSE), with contributing documentation, a security policy, a code of conduct and issue templates so external contributors can take part. Managed hosting is offered commercially from the same source; no core support feature is withheld from the published code.
- Keep operational support metrics (volume, response and resolution time, Product and channel mix) in the application's own database; third-party analytics, where used, is hosted-only and never the source of support metrics.
- Make no unverified claims: no compliance claims (HIPAA, SOC 2, PCI, GDPR, CCPA) until independently verified, no unsubstantiated superlatives, "unlimited" or "secure by default" wording. Legal documents are drafts for qualified review, and self-hosting documentation states that the operator is responsible for their own hosting, data processing, privacy obligations, email configuration and applicable law.
- Prefer a polished core workflow over a broad feature catalogue, and keep the inbox efficient for someone who spends hours in it: dense, fast, clear Product identity, good empty states, no template-default or decorative clutter.
- Build accessible primitives from the start (semantic HTML, accessible components) so the later WCAG AA pass is not a rewrite.

## V1 boundary

V1 comprises Workspace and Admin/Agent access; multiple Products and domain-controlled widgets; a unified searchable inbox; anonymous live chat and email-based away replies; inbound and outbound Product support email; developer identify/context APIs; a token-authenticated Workspace API for managing Products and their domains (FR-API-01..03); an agent-first extension of that API (conversations, contacts, saved replies, tokens, outbound webhooks and API onboarding; FR-API-04..17, planned, see [agent-api-plan.md](agent-api-plan.md)) is added after the core V1 flows; Conversation status, notes, tags and saved replies; attachments; onboarding; hosted usage/billing; and a deployable self-hosted edition. The same core support features are available in either hosting mode. The marketing site, analytics, draft legal documents and demo seeding are launch-readiness work outside this boundary (decided 2026-09-25), done later and separately. V1 roles are Admin and Agent only — no complex RBAC — and V1 Product branding is name and primary colour only (no custom CSS). See [FRD.md](FRD.md) for behaviour and [architecture.md](architecture.md) for implementation direction.

## Journeys and proof

1. Create a Workspace and Product, configure a domain, embed the widget, send an anonymous message, then see and answer it in the inbox.
2. Add a second Product, receive messages for both, filter to either Product and return to all.
3. Send support email to a Product address, continue the correct Conversation, reply from the inbox and deliver the reply by email.
4. Set support to away, collect a reply address and continue the chat through email.
5. Attach application context and a file, then verify only authorised participants can see them.
6. Install the self-hosted edition from documented instructions and complete the same support flows.

V1 succeeds when these journeys work in a browser and cross-Workspace access attempts fail. Do not substitute a passing build for these outcomes.

## Later and outside scope

Later work (V2) may add automatic diagnostics, richer branding (logo/avatar, launcher position, greeting), typing indicators and presence, assignment and priority, verified custom sending domains, a dashboard audit-log viewer (the API audit log itself is planned with FR-API-11), configurable retention, legal/privacy review, accessibility hardening and more analytics. Diagnostics must be explicitly enabled per Product, disclosed, strongly redacted, and never capture cookies, authentication headers or tokens, passwords, payment details, request/response bodies, form values or browser storage. Further out (V3+): launcher icon and wording customisation, required contact fields, knowledge base, AI assistant and suggested replies, SLA tooling, automation and advanced permissions, integrations, mobile apps, a broader webhooks/API ecosystem (basic outbound webhooks and the Workspace API are planned earlier under FR-API-12..13), and social/messaging channels.

Outside the initial release: knowledge bases, AI agents/chatbots, enterprise CRM and custom workflow builders, SLA engine, advanced automation, social/phone channels, enterprise SSO, white-label reseller features, session replay or arbitrary console capture, a Sentry replacement, and a mail server.

## Maintenance rule

This document owns the durable **why and scope**. Behavioural rules live in the FRD; technology choices in architecture and ADRs; current prices, vendors, dates, competitor details and task order elsewhere. Undecided questions live in [open-questions.md](open-questions.md). Change a product decision here in the same PR that changes its behaviour.
