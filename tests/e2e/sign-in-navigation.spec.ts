import { expect, test, type Page } from "@playwright/test";

import { loadFixtures, signIn } from "./helpers";

/**
 * Regression: sign-in must end in a full document navigation, not a soft
 * navigation. Auth pages render Links to protected routes (the header logo →
 * /inbox), and a logged-out prefetch of a protected route caches the proxy's
 * 307-to-/login inside the client router. A soft push to the same route then
 * replays the stale redirect and the router wedges — the user stays on
 * /login with a pending form until a manual refresh.
 *
 * The suite runs against `next dev`, where App Router Link prefetching is
 * disabled — the poisoning itself cannot be staged here. What the spec locks
 * in is the invariant that fixes it either way: the post-sign-in landing is
 * a fresh document navigation entry (SPA transitions keep the original
 * document entry), so no client router state can swallow the redirect.
 */

/**
 * Fill and submit the login form already on screen. `signIn` in helpers
 * always reloads `/login`, which would drop this spec's prefetch wait and
 * `next` query.
 */
async function submitLoginForm(page: Page, email: string, password: string): Promise<void> {
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The document navigation entry a full page load creates (SPA navs do not). */
async function currentDocumentUrl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation").at(0);
    if (!entry) return "(none)";
    const url = new URL(entry.name);
    return url.pathname + url.search;
  });
}

test.describe.serial("sign-in navigation", () => {
  test("sign-in lands on the inbox via a document navigation after prefetched redirects", async ({ page }) => {
    const fixtures = loadFixtures();

    // Load /login logged out and let the page settle. In production the
    // auth-page Link prefetches would land here; in dev they do not fire
    // (see the spec header) — the sleep just keeps the run stable.
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.waitForTimeout(1500);

    await submitLoginForm(page, fixtures.beta.owner.email, fixtures.beta.owner.password);

    // The URL must be the inbox, and it must be a fresh document entry
    // (name reflects the /inbox load), not the original /login document.
    await expect(page.getByRole("tablist", { name: "Conversation status" })).toBeVisible();
    const doc = await currentDocumentUrl(page);
    expect(doc.startsWith("/inbox"), `document entry was ${doc}`).toBeTruthy();
  });

  test("a scheme-relative next target is rejected, never followed off-origin", async ({ page }) => {
    const fixtures = loadFixtures();

    // `/\host` parses as a scheme-relative URL in browsers (backslashes
    // normalize to slashes, tab/CR/LF are stripped before parsing), and a
    // same-origin absolute URL with a double-slash pathname smuggles the
    // same //host back through validation. With window.location.assign
    // either would be an open redirect; the form must fall back to
    // /inbox instead. Cover literal, %-encoded and absolute forms.
    const appOrigin = new URL(page.url()).origin;
    for (const next of [
      "/\\evil.example",
      "/%09/evil.example",
      `${appOrigin}//evil.example`,
    ]) {
      await page.goto(`/login?next=${next}`);
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await signIn(page, fixtures.beta.owner.email, fixtures.beta.owner.password);
      await expect(page.getByRole("tablist", { name: "Conversation status" })).toBeVisible();
      expect(new URL(page.url()).host).not.toBe("evil.example");
      await page.context().clearCookies({ name: "better-auth.session_token" });
      await page.context().clearCookies({ name: "__Secure-better-auth.session_token" });
    }
  });

  test("an already authenticated visit to /login goes straight to the app", async ({ page }) => {
    const fixtures = loadFixtures();
    await signIn(page, fixtures.beta.owner.email, fixtures.beta.owner.password);

    // Plain visit: the dashboard, never the login form.
    await page.goto("/login");
    await expect(page.getByRole("tablist", { name: "Conversation status" })).toBeVisible();
    await expect(page).toHaveURL(/\/inbox\/?$/u);

    // A same-origin next is honored under the same rules as the
    // post-sign-in redirect…
    await page.goto("/login?next=%2Fsaved-replies");
    await expect(page).toHaveURL(/\/saved-replies\/?$/u);

    // …and an off-origin smuggle via next is not.
    const appOrigin = new URL(page.url()).origin;
    await page.goto(`/login?next=${encodeURIComponent(`${appOrigin}//evil.example`)}`);
    await expect(page).toHaveURL(/\/inbox\/?$/u);
    expect(new URL(page.url()).host).not.toBe("evil.example");
  });

  test("the dashboard root presents sign-in, then forwards a signed-in visitor", async ({ page }) => {
    const fixtures = loadFixtures();

    // Marketing-site CTAs link here with plain absolute URLs; no dead ends.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login\/?$/u);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await signIn(page, fixtures.beta.owner.email, fixtures.beta.owner.password);
    await expect(page.getByRole("tablist", { name: "Conversation status" })).toBeVisible();

    await page.goto("/");
    await expect(page).toHaveURL(/\/inbox\/?$/u);
    // The marketing site's sign-up CTA is sign-in aware the same way.
    await page.goto("/register");
    await expect(page).toHaveURL(/\/inbox\/?$/u);
  });
});
