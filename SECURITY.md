# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/Supportseal/SupportSeal-app/security/advisories/new).
Do not open a public issue or pull request for a vulnerability.

Include what you found, how to reproduce it, and the version or commit you
tested. We aim to acknowledge reports within 3 working days and will keep you
updated until a fix ships. Reporters are credited in the advisory unless they
ask not to be.

## Scope

In scope: this repository's code, including the dashboard, the chat widget,
the API, email handling and the Docker setup, and the hosted service at
`dashboard.supportseal.app`.

Especially relevant: anything that lets one Workspace read or change another
Workspace's data. Workspace isolation is a security boundary (FR-SEC-01,
ADR-0001).

Out of scope: findings that need a compromised server or admin account,
rate-limit bypasses on an instance exposed without the reverse proxy that
[docs/self-hosting.md](docs/self-hosting.md) requires, and missing best-practice
headers with no demonstrated impact.

## Supported versions

Only the latest `main` is supported. Self-hosters should upgrade as described
in [docs/self-hosting.md](docs/self-hosting.md#upgrades).
