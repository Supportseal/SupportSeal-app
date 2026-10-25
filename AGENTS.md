# SupportSeal agent guide

Open-source customer support platform for people building several products
(SupportSeal is the product name; centrally configured in
`src/config/site.ts` — never hard-code it). Product behaviour questions go
to docs/PRD.md / docs/FRD.md; anything undecided lives in
docs/open-questions.md — never guess an answer to an open question.

## Setup and exact commands

- Node ≥22 <25 (`.nvmrc` = 22), npm. `npm install` runs `postinstall` →
  `prisma generate`.
- Copy `.env.example` → `.env`. Dev: `npm run db:dev` (migrates the local
  file-backed PGlite database at `.dev-data/`), then `npm run dev`. With a
  real Postgres: set `DATABASE_URL`, use `npm run db:migrate`.
- Build: `npm run build` (prisma generate + next build, standalone output),
  then `npm run start`.
- Path alias `@/*` → `src/*` (tsconfig + vitest). Next.js 16 App Router,
  React 19, Tailwind CSS 4; UI kit in `src/components` +
  `src/styles/tokens.css`.
- Prisma client output → `src/generated/prisma` (gitignored). After schema
  changes: `npx prisma generate` and a migration via `npx prisma migrate dev`
  against a real Postgres (or hand-write `prisma/migrations/<ts>_name/`
  and replay with `npm run db:dev` + tests).

## Verification matrix

| Command | Meaning |
| --- | --- |
| `npm run verify:fast` | lint + typecheck + unit/integration tests |
| `npm run verify` | verify:fast + build |
| `npm run verify:full` | verify + Playwright E2E (hosted + self-hosted) |

- Single test file: `npm run test:run -- src/lib/__tests__/brand.test.ts`.
- Integration tests run on in-memory PGlite (no external database needed).
- E2E (`npm run test:e2e`) boots its own `next dev` servers on ports 3100
  (hosted) and 3200 (self-hosted) against throwaway PGlite databases; it
  needs `npx playwright install chromium` once and free ports
  3100/3101/3102/3200/1025. On hosts where the pinned Chromium cannot run,
  set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a working build.
- Browser verification is mandatory for every important user-facing flow;
  unit tests alone are not acceptance. Reference procedures: the V1
  acceptance path and the two-Workspace cross-tenant check in
  docs/FRD.md. Cross-Workspace access attempts must fail.

## Architecture map

- Modular monolith (Next.js 16 App Router, React 19) + separately bundled
  chat widget. Dashboard routes in `src/app/(app)`, auth pages in
  `src/app/(auth)`, API routes in `src/app/api`, onboarding and widget
  preview under `src/app/`. Route protection lives in `src/proxy.ts`;
  `/` sends signed-in users to `/inbox` and everyone else to sign-in.
- The public marketing site (pages, legal policies, brand cards, marketing
  docs) lives in the private `supportseal-marketing` repository on
  `supportseal.app`; the hosted app runs on `dashboard.supportseal.app`.
  Never add marketing pages, copy or assets here. Apex `/widget.js`,
  `/widget`, `/widget-diagnostics.js` and `/api/*` still reach this app
  (legacy routers in `docker-compose.hosted.yml`), so widget and webhook
  code must keep deriving origins from the request, not `NEXT_PUBLIC_APP_URL`.
- Domain modules in `src/lib/`: workspace, products, conversations,
  saved-replies, attachments, usage (billing metering), stripe, `email/`
  (inbound/outbound adapters), widget, events (SSE delivery), dev-context,
  api-tokens / admin-api / api-errors / product-api (token-authenticated
  Workspace API, FR-API-01..03; contract in `docs/openapi.json`, kept in
  sync by `src/lib/__tests__/openapi-drift.test.ts`).
- Auth is better-auth in-process against Prisma (`src/lib/auth.ts`,
  ADR-0002). Prisma schema at `prisma/schema.prisma`; client output →
  `src/generated/prisma` (gitignored). CI: `.github/workflows/ci.yml`;
  dev scripts in `scripts/` (`dev-db.mjs`, `seed-dev.ts`).
- Decided from the direction docs: realtime delivery (ADR-0003 accepted;
  [issue #2](https://github.com/Supportseal/SupportSeal-app/issues/2)) and the
  hosted-tier host — the existing self-hosted deployment fleet for now, a
  dedicated VPS once paying customers arrive (internal decision record; see docs/architecture.md).
- Document map: docs/PRD.md (why/scope) and docs/FRD.md (observable V1
  behaviour, stable requirement IDs) are canonical; docs/open-questions.md
  records decisions taken and maintainer-overridable defaults.

## Important invariants and safety constraints

- Workspace isolation is a security boundary: every tenant-aware operation
  must prove Workspace ownership (FR-SEC-01, ADR-0001). A self-hosted
  deployment serves exactly one Workspace; additional Workspaces are blocked.
- Licence is AGPLv3 (LICENSE at the root).
- SupportSeal is the product name; use the central configurable brand name
  (application config), never scattered hard-coded names.

## PR workflow

- Evaluate every review finding, human or automated, against requirements,
  tests, architecture and runtime behaviour; do not blindly apply
  suggestions.
- Before any PR: formatting, lint, typecheck, tests and build **where they
  exist**; for user-facing functionality actually run the application —
  compilation is not proof. Visual PRs include screenshots with realistic
  data.
- One coherent idea per PR. Target <600 meaningful changed lines; avoid
  >1,000 without a justified reason. Stacked PRs: base correctly on the
  parent, make the dependency obvious, never duplicate the parent's changes,
  retarget when the parent merges.

## Deployment and post-deployment checks

- Self-hosting target is `docker compose up` (Postgres + one-shot migrate +
  app; groundwork committed) — full guide in [docs/self-hosting.md](docs/self-hosting.md).
  The hosted tier runs on the existing self-hosted deployment fleet for now,
  moving to a dedicated VPS once paying customers arrive (decision and
  comparison in the internal decision record (docs/architecture.md).
  Self-hosted mode must never require Stripe, the hosted API or external
  telemetry (FR-HOST-01).

## Known non-obvious gotchas

- The PRD/FRD are canonical; when another document conflicts with them,
  resolve it explicitly via docs/open-questions.md instead of silently
  picking a side.
- Deferred specs live as GitHub issues on Supportseal/SupportSeal-app
  (docs/open-questions.md has the pointers).

## Definition of done

- Docs-only PRs: lint + build still apply where the toolchain covers the
  changed files; otherwise state explicitly which checks were run.
- Contributions arrive as a pull request for a maintainer to review and
  merge — the merge is the deploy trigger; never push `main` directly.
- Target <600 meaningful changed lines per PR.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
