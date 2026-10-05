import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // apps/site/src/lib holds the site's pure modules (ads, security headers); their tests run here too.
    include: ["packages/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts", "apps/site/src/lib/**/*.test.ts"],
    reporters: process.env.CI ? ["default", "github-actions"] : ["default"],
  },
});
