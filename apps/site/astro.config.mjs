// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// Astro 7 + @astrojs/cloudflare 14. `astro dev` runs inside workerd through
// @cloudflare/vite-plugin; bindings come from `import { env } from "cloudflare:workers"`.
const BUILD_VERSION =
  process.env.BUILD_VERSION ?? process.env.GITHUB_SHA?.slice(0, 12) ?? "dev";

// Draft guides (SPEC.md 9.8) are built only when NODE_ENV !== "production" at build
// time. Astro sets NODE_ENV before it loads this file when it isn't already set:
// "development" for `astro dev`, "production" for `astro build`, `astro check` and
// `astro sync`. So `pnpm build` (deploy.yml, Docker) leaves drafts out, `pnpm dev`
// includes them, and `NODE_ENV=development pnpm build` (the e2e harness) builds
// them too. The answer is passed to src/content.config.ts (which drops drafts from
// the collection, so their text never reaches dist/) and to the pages as
// `import.meta.env.GUIDE_DRAFTS`. Read NODE_ENV here, not in Vite-processed modules:
// Vite rewrites `process.env.NODE_ENV` in those to the build mode.
const GUIDE_DRAFTS = process.env.NODE_ENV !== "production";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    // No IMAGES binding: the site serves no organizer images or logos (CLAUDE.md).
    imageService: "passthrough",
  }),
  // No accounts and no sessions. `false` keeps the session runtime out of the bundle
  // and stops the adapter from requiring a SESSION KV binding.
  session: false,
  site: process.env.PUBLIC_SITE_URL ?? "http://localhost:8787",
  // One URL policy: no trailing slash. Prerendered pages are written as about.html
  // so the static asset handler serves them at /about without a redirect.
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "always" },
  server: { port: 4321, host: true },
  vite: {
    // Never inline scripts: the CSP allows scripts from 'self' only, with no
    // inline hashes to keep in sync.
    build: { assetsInlineLimit: 0 },
    define: {
      "import.meta.env.BUILD_VERSION": JSON.stringify(BUILD_VERSION),
      "import.meta.env.GUIDE_DRAFTS": JSON.stringify(GUIDE_DRAFTS),
    },
  },
});
