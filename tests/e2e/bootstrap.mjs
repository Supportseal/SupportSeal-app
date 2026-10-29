#!/usr/bin/env node
/**
 * E2E app-server bootstrap, used as the Playwright webServer command.
 * Builds a throwaway environment for one suite run and then keeps
 * `next dev` alive as a child process:
 *
 *   1. wipe the run directory (database file + uploads + fixtures) and the
 *      `next dev` cache when the previous e2e run used the other mode
 *   2. replay prisma migrations onto a fresh file-backed PGlite database
 *   3. (hosted) seed the cross-Workspace fixtures
 *   4. spawn `next dev` with the run's env; forward signals so Playwright
 *      can stop the whole tree.
 *
 * Env (set by the playwright configs):
 *   E2E_MODE       hosted | selfhosted
 *   E2E_PORT       app port (3000 hosted, 3200 selfhosted)
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { E2E_SHARED_SECRET, E2E_SUPPORT_WIDGET_KEY } from "./shared-secret.mjs";

const MODE = process.env.E2E_MODE === "selfhosted" ? "selfhosted" : "hosted";
const PORT = process.env.E2E_PORT || (MODE === "selfhosted" ? "3200" : "3100");
const RUN_DIR = path.join(process.cwd(), "tests", "e2e", ".runtime", MODE);
const DATA_DIR = path.join(RUN_DIR, "data");
const NEXT_DIR = path.join(process.cwd(), ".next");
const NEXT_DEV_MODE_FILE = path.join(NEXT_DIR, "e2e-mode");
const FIXTURES_FILE = path.join(RUN_DIR, "fixtures.json");
const SHARED_SECRET = E2E_SHARED_SECRET;

const appEnv = {
  ...process.env,
  DATABASE_URL: "",
  PGLITE_PATH: path.join(DATA_DIR, "pglite.db"),
  STORAGE_DIR: path.join(DATA_DIR, "uploads"),
  NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
  BETTER_AUTH_SECRET: SHARED_SECRET,
  INBOUND_WEBHOOK_SECRET: SHARED_SECRET,
  INBOUND_EMAIL_DOMAIN: "inbound.localhost",
  SMTP_URL: "",
  // Keep `next dev` from logging requests into Turbopack's watch scope
  // (see next.config.ts, mcpServer).
  NEXT_DEV_MCP: "0",
  // Hosted: the dashboard embeds its own support chat (seeded Product).
  // Self-hosted: never configured, so no widget renders.
  ...(MODE === "hosted"
    ? { HOSTED_MODE: "1", SMTP_URL: "smtp://127.0.0.1:1025", SUPPORT_WIDGET_KEY: E2E_SUPPORT_WIDGET_KEY }
    : { HOSTED_MODE: "", SUPPORT_WIDGET_KEY: "" }),
};

async function main() {
  await fs.rm(RUN_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });

  // Hosted and self-hosted share `.next/dev`; reusing its Turbopack cache
  // across modes makes pages full-reload in a loop. Drop it when the mode
  // changes since the last e2e run.
  const lastMode = await fs.readFile(NEXT_DEV_MODE_FILE, "utf8").catch(() => "");
  if (lastMode !== MODE) {
    await fs.rm(path.join(NEXT_DIR, "dev"), { recursive: true, force: true });
    await fs.mkdir(NEXT_DIR, { recursive: true });
    await fs.writeFile(NEXT_DEV_MODE_FILE, MODE);
  }

  const migrate = spawnSync(process.execPath, ["scripts/dev-db.mjs"], {
    env: appEnv,
    stdio: "inherit",
  });
  if (migrate.status !== 0) {
    console.error(`[e2e-bootstrap] migrations failed (exit ${migrate.status})`);
    process.exit(1);
  }

  if (MODE === "hosted") {
    const seed = spawnSync("npx", ["tsx", "tests/e2e/seed.ts"], {
      env: { ...appEnv, E2E_FIXTURES_FILE: FIXTURES_FILE },
      stdio: "inherit",
    });
    if (seed.status !== 0) {
      console.error(`[e2e-bootstrap] seed failed (exit ${seed.status})`);
      process.exit(1);
    }
  }

  console.log(`[e2e-bootstrap] starting next dev (${MODE}) on :${PORT}`);
  // Spawn the real next binary (not npx) so signalled shutdowns reach the
  // server directly; escalate to SIGKILL if it ignores SIGTERM.
  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "dev", "--port", PORT],
    { env: appEnv, stdio: "inherit" },
  );

  const forward = (signal) => {
    child.kill(signal);
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("exit", () => clearTimeout(force));
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
