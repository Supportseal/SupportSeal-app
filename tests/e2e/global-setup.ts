import { loadFixtures } from "./helpers";

/**
 * Best-effort route warming for the dev server: `next dev` compiles each
 * route on first hit, which can take 10s+ on cold Turbopack and would
 * otherwise eat the first test's expect timeout. Runs after the webServer is
 * ready (Playwright guarantees that ordering). Failures are ignored — the
 * tests themselves remain the source of truth.
 */
export default async function globalSetup() {
  const app = process.env.E2E_APP_URL || "http://localhost:3100";
  const warm = async (path: string, init?: RequestInit) => {
    try {
      await fetch(app + path, { signal: AbortSignal.timeout(120_000), ...init });
    } catch {
      // warming is best-effort
    }
  };

  await Promise.all([
    warm("/api/health"),
    warm("/login"),
    warm("/register"),
    warm("/widget.js"),
    warm("/widget-preview"),
    warm("/onboarding"),
    warm("/inbox"),
  ]);

  const fixtures = loadFixtures();
  const login = await fetch(app + "/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: app },
    body: JSON.stringify({
      email: fixtures.beta.owner.email,
      password: fixtures.beta.owner.password,
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);
  if (login?.ok) {
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const authed = { cookie } as Record<string, string>;
    await Promise.all([
      warm("/inbox", { headers: authed }),
      warm("/saved-replies", { headers: authed }),
      warm("/settings/team", { headers: authed }),
      warm("/settings/products", { headers: authed }),
      warm("/onboarding/install", { headers: authed }),
    ]);
  }
}
