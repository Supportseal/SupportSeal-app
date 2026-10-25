# ADR 0002 — Independent authentication

Status: Accepted. Library chosen: [better-auth](https://better-auth.com) (validated during implementation, initially tracked as [pietervw/SupportSeal-app#5](https://github.com/pietervw/SupportSeal-app/issues/5))
Date: 2026-09-25

## Decision

Use authentication and session storage that run entirely with the application and its database. Support email/password sign-in, reset and invitations for Admin/Agent access. Hosted mode uses the same core identity flow; optional external identity providers may be added without becoming a requirement. Authorisation always resolves Workspace membership and role server-side.

## Why

Several existing projects use Clerk, but this product promises a fully independent self-hosted installation. Requiring a proprietary hosted auth service would break that promise.

## Consequences

better-auth runs entirely in-process against the Prisma database: email/password credentials (scrypt hashes), database-backed sessions, and a Next.js route handler. Password reset emails and invite emails arrive with the email slices. Workspace membership and roles stay in our own Prisma models — no auth-provider IDs define Product or Conversation models. Rate limiting, secure cookies and reset-token expiry come from the library defaults plus our Workspace-level guards.
