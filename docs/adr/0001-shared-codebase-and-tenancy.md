# ADR 0001 — Shared application and Workspace isolation

Status: Accepted direction
Date: 2026-09-25

## Decision

Build a modular monolith and a separately bundled widget. Hosted SaaS and self-hosted installs share the same application code and Workspace-aware database model; a self-hosted deployment represents exactly one Workspace in V1 — additional Workspaces are blocked by the application, not merely untested (decided 2026-09-25). Every tenant-owned query and mutation verifies Workspace ownership and role, with relational constraints and cross-tenant tests as additional safeguards.

## Why

The support flows are closely coupled, while separate services would complicate self-hosting. Keeping the same tenant boundary in both modes prevents a second, divergent implementation.

## Consequences

Database, API, job, search, attachment and widget paths all require tenant-aware tests. Extract a service only after a concrete operational constraint justifies it.
