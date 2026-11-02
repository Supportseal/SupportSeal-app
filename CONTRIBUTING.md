# Contributing to SupportSeal

Thanks for considering it. SupportSeal is early — the most useful
contributions right now are bug reports from real installs, docs fixes,
and small well-scoped PRs.

## Getting set up (≈5 min)

```bash
git clone https://github.com/Supportseal/SupportSeal-app.git
cd SupportSeal-app
cp .env.example .env
npm install        # also runs prisma generate
npm run db:dev     # local PGlite database in .dev-data/ — no DATABASE_URL needed
npm run dev        # http://localhost:3000
```

Node ≥22 (<25) and npm. Full setup, architecture and verification detail
lives in [AGENTS.md](AGENTS.md).

## Before you send a PR

- `npm run verify:fast` must pass (lint + typecheck + tests); `npm run
  verify` adds the build.
- Keep PRs small and described in terms of user-visible behavior.
- Anything that changes direction or adds a dependency: open an issue
  first. Check [docs/adr/](docs/adr) and
  [docs/open-questions.md](docs/open-questions.md) for decisions already
  taken.
- Browser-verify user-facing flows you touch; unit tests alone are not
  acceptance (see [AGENTS.md](AGENTS.md)).

## Good first issues

See the [contribute view](https://github.com/Supportseal/SupportSeal-app/contribute)
or issues labeled
[`good first issue`](https://github.com/Supportseal/SupportSeal-app/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## Licence

AGPL-3.0 — contributions come under the same license.
