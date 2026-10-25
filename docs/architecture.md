# Architecture direction

This is the initial technical direction for the behaviours in [FRD.md](FRD.md). Specific libraries and providers are chosen only after a working spike or comparison; significant changes belong in an ADR.

## Shape and boundaries

Build one modular application with a small independently bundled browser widget. The application owns the Workspace, Product, Contact, Conversation, Message, Attachment, email, usage and billing modules. The widget communicates with public Product-scoped endpoints; it never receives privileged server credentials or the dashboard bundle. Hosted mode serves many Workspaces; self-hosted mode serves exactly one Workspace in V1 (enforced: additional Workspaces are blocked; [ADR-0001](adr/0001-shared-codebase-and-tenancy.md)), using the same Workspace-aware schema and authorisation path.

Next.js/TypeScript with PostgreSQL and Prisma is a reasonable starting stack. Deployment must run outside a proprietary platform. The long-lived request and background-job requirements were validated by the [ADR-0003](adr/0003-realtime-delivery.md) spike; the hosted tier runs on the existing self-hosted deployment fleet for now and moves to a dedicated VPS once paying customers arrive (comparison and decision in [pietervw/SupportSeal-app#3](https://github.com/pietervw/SupportSeal-app/issues/3)). Use ordinary database migrations and a recoverable file store, local for simple self-hosting and S3-compatible for managed storage. Add no Redis or separate search engine without measured need.

## Data and isolation

Make Workspace ownership explicit on tenant data; Product-owned records also carry Product identity. Use foreign keys and composite constraints where possible, request-scoped authorisation checks, and cross-Workspace integration tests. Public widget keys identify Products but confer no privileged access. Visitor sessions are unguessable, scoped to the Product/Conversation and protected against replay and enumeration. Agent access requires membership and role checks. Cross-Product Contact linking is internal and not shown by default.

Persist Conversations, Messages and usage events as first-class records; use bounded JSON only for explicitly submitted developer context. A Conversation can contain chat and email messages. Count each Conversation once, when it is first opened, in the billing period in which it opened, and never again in a later period (FR-USE-01 in [FRD.md](FRD.md): a Conversation is counted once ever); preserve an auditable ledger and handle duplicate events idempotently. Status transitions, search and attachment access all go through the same ownership boundary.

## Delivery and integrations

The delivery direction — a server-to-client event stream for new chat/inbox events, durable message writes before notifying clients, resumable cursors and a polling fallback — was validated by the two-process reverse-proxy spike and [ADR-0003](adr/0003-realtime-delivery.md) is accepted (2026-09-26; measurements in [issue #2](https://github.com/pietervw/SupportSeal-app/issues/2)). Browser submissions use normal authenticated requests. PostgreSQL stays the coordination point — in-process notification plus bounded database polling today, with `LISTEN`/`NOTIFY` as the measured upgrade path; no Redis by default.

Put email providers behind inbound/outbound adapters. Authenticate inbound webhooks, deduplicate provider deliveries, parse and sanitise mail, and thread by validated headers or secure reply identifiers. Persist outgoing work and delivery outcome so failures are visible and retriable. Compare providers for both hosted and self-hosted use; do not require the managed provider for self-hosters. See [ADR-0004](adr/0004-email-boundary.md).

Hosted-only modules provide Stripe billing and optional analytics. Core support behaviour never calls those modules in self-hosted mode. Keep external telemetry off there by default. Authentication is local to this deployment; see [ADR-0002](adr/0002-independent-authentication.md).

## Verification and operations

Use unit tests for parsing, validation and usage rules; integration tests for authentication, mail, idempotency and tenant boundaries; browser tests for onboarding, widget chat and inbox/email continuation. Run the application in desktop and mobile browsers. Ship a documented Compose installation, migrations, persistent volumes, backups and upgrades. Keep structured logs useful without logging tokens, credentials or unnecessary message content. Document storage and email configuration rather than embedding secrets in client code.
