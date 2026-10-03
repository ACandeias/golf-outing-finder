import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite (SPEC.md v1.1 section 11): Playwright against `wrangler dev`
 * with a seeded local D1 and SITE_NOW=2026-09-28.
 *
 * tests/e2e/global-setup.ts builds the site, migrates and seeds a throwaway D1
 * state directory, starts `wrangler dev` on a free port and exports its origin as
 * E2E_BASE_URL before the workers start, so `baseURL` below resolves in every
 * worker. Set E2E_BASE_URL yourself to run against a server you started.
 */
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Building and seeding take a few minutes on a cold CI runner.
  globalTimeout: 20 * 60_000,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  workers: CI ? 2 : 4,
  reporter: CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: "retain-on-failure",
    // Light scheme, desktop Chrome: the defaults the accessibility smoke runs in.
    colorScheme: "light",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
