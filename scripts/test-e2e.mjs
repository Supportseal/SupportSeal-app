// Runs the hosted and self-hosted Playwright suites back to back. A hosted
// failure must not hide the self-hosted suite, so both always run and the
// summary names each result; the exit code is non-zero if either failed.
import { spawnSync } from "node:child_process";

const suites = [
  ["hosted", "playwright.config.ts"],
  ["self-hosted", "playwright.selfhosted.config.ts"],
];

const results = suites.map(([name, config]) => {
  const run = spawnSync("npx", ["playwright", "test", "-c", config, ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return [name, run.status === 0];
});

console.log("\nE2E summary:");
for (const [name, ok] of results) console.log(`  ${name}: ${ok ? "passed" : "FAILED"}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
