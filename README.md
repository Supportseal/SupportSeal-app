# SupportSeal

**SupportSeal** is an open-source customer support platform for people who
build several independent products: one unified inbox, a chat widget and
first-class support email per Product, deliberate developer/application
context, and a choice between managed hosting and genuine self-hosting from
the same source. See [docs/PRD.md](docs/PRD.md) for the product promise.

## Status

**Early build.** Next.js 16 App Router + TypeScript, Tailwind CSS 4, Prisma 7 +
PostgreSQL (PGlite for instant local dev), Vitest. Docker/self-hosting
groundwork is in place.

### Local development

Requires Node.js **22–24** (Node 22 recommended; see `.nvmrc`) and npm.

```bash
git clone https://github.com/pietervw/SupportSeal-app.git
cd supportseal
cp .env.example .env
npm install          # also runs prisma generate
npm run db:dev       # migrate the local PGlite database (.dev-data/)
npm run dev          # http://localhost:3000 (no DATABASE_URL needed)
```

With a real Postgres instead: set `DATABASE_URL` in `.env` (copy from
`.env.example`) and run `npm run db:migrate`.

### Commands

| Command | Meaning |
| --- | --- |
| `npm run verify:fast` | lint + typecheck + tests |
| `npm run verify` | verify:fast + build |
| `npm run verify:full` | verify + hosted and self-hosted Playwright E2E suites |

Before running E2E, install Chromium with `npx playwright install chromium`.
The suites start their own dev servers and throwaway databases; ports
3100/3101/3102/3200/1025 must be free.

### Self-hosting

`docker compose up` runs Postgres, applies migrations once via the `migrate`
target, then serves the app on http://localhost:3000 (health: `/api/health`).
The full guide — environment reference, email setup, HTTPS proxy, backups and
upgrades — is [docs/self-hosting.md](docs/self-hosting.md).

## Read this first

- [docs/PRD.md](docs/PRD.md) and [docs/FRD.md](docs/FRD.md) are the
  **canonical** product requirements (scope and observable V1 behaviour).
- [docs/open-questions.md](docs/open-questions.md) tracks decisions taken
  and maintainer-overridable defaults.
- [AGENTS.md](AGENTS.md) summarises the contribution and verification rules
  for coding agents.

## Document map

| File | What it owns |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | Durable product why and scope |
| [docs/FRD.md](docs/FRD.md) | Observable V1 behaviour (stable requirement IDs) |
| [docs/product-positioning.md](docs/product-positioning.md) | Positioning hypothesis and message hierarchy |
| [docs/architecture.md](docs/architecture.md) | Technical direction |
| [docs/widget-integration.md](docs/widget-integration.md) | Widget installation, Next.js/React example, domains and support address |
| [docs/add-product.md](docs/add-product.md) | Runbook: add a Product to an existing instance (domains, email, widget key, smoke test) |
| [docs/api-quickstart.md](docs/api-quickstart.md) | Create a Product, allow domains and read the widget key over the token-authenticated API (curl, error table, coding-agent notes) |
| [docs/openapi.json](docs/openapi.json) | OpenAPI 3.1 spec of the token-authenticated Workspace API; every installation serves it live, public, at `GET /api/openapi.json` |
| [docs/api-tokens.md](docs/api-tokens.md) | API tokens: create, revoke, scopes, error reference |
| [docs/adr/](docs/adr) | Decisions: tenancy (0001), auth (0002), realtime (0003), email boundary (0004) |
| [docs/open-questions.md](docs/open-questions.md) | Decisions taken and maintainer-overridable defaults |
| [AGENTS.md](AGENTS.md) | Agent guide (PR workflow, verification) |

## Contributing

Open an issue for bugs or proposed changes, and submit pull requests against
`main`. Read [AGENTS.md](AGENTS.md) for the architecture, safety constraints
and verification rules. Run `npm run verify` before submitting; important
user-facing flows also need browser verification. Product requirements live
in the PRD/FRD linked above; unresolved decisions belong in
[docs/open-questions.md](docs/open-questions.md).

## Licence

AGPLv3 — see [LICENSE](LICENSE).
