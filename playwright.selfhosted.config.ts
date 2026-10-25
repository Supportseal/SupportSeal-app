import { defineConfig } from "@playwright/test";

/**
 * Self-hosted-mode core suite (FR-HOST-01): default deployment mode, exactly
 * one Workspace, registration closes after the first Workspace, billing is
 * absent. Separate config because it needs its own app server, port and
 * throwaway database.
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim() || undefined;

export default defineConfig({
  testDir: "tests/e2e/selfhosted",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...(chromiumExecutable
      ? { launchOptions: { executablePath: chromiumExecutable } }
      : { channel: "chromium" }),
    baseURL: "http://localhost:3200",
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
      command: "E2E_MODE=selfhosted E2E_PORT=3200 node tests/e2e/bootstrap.mjs",
      url: "http://localhost:3200/api/health",
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
