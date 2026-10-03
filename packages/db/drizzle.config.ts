import { defineConfig } from "drizzle-kit";

// migrations/0000_init.sql is written from SPEC.md section 7.1 by hand: drizzle-kit 0.31
// quotes the COALESCE expression in outings_dedupe as column names and does not emit
// the CHECK constraints. `pnpm --filter @gof/db generate` writes to .drizzle/ (ignored)
// so its output can be diffed against the real migrations without replacing them.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./.drizzle",
});
