import { defineConfig } from "@playwright/test";

/**
 * Hosted-mode acceptance suite (HOSTED_MODE=1, multi-Workspace). Runs against
 * a throwaway file-backed PGlite database via `next dev` (see
 * tests/e2e/bootstrap.mjs); the support process provides the widget host page
 * and the SMTP catch server used by the email tests.
 *
 * On hosts where the Playwright-pinned Chromium cannot run (missing system
 * libraries), point PLAYWRIGHT_CHROMIUM_EXECUTABLE at a working Chromium
 * build (same major version).
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim() || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: /selfhosted/u,
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "tests/e2e/global-setup.ts",
  use: {
    ...(chromiumExecutable
      ? { launchOptions: { executablePath: chromiumExecutable } }
      : { channel: "chromium" }),
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node tests/e2e/support-servers.mjs",
      url: "http://localhost:3101/healthz",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node tests/e2e/bootstrap.mjs",
      url: "http://localhost:3100/api/health",
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
