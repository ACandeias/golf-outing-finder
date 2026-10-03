import { defineConfig } from "@playwright/test";

// e2e runs against the built Worker in `wrangler dev` with a local D1 (SPEC.md 11).
// SITE_NOW pins the clock; NODE_ENV=development lets the override apply.
export default defineConfig({
  testDir: "./tests/e2e",
  globalTimeout: 10 * 60_000,
  webServer: {
    command:
      "pnpm run db:migrate:local && pnpm run build && pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8787 --var NODE_ENV:development --var SITE_NOW:2026-09-28",
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
  use: {
    baseURL: "http://127.0.0.1:8787",
  },
});
