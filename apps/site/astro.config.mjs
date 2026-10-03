// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// Astro 7 + @astrojs/cloudflare 14. `astro dev` runs inside workerd through
// @cloudflare/vite-plugin; bindings come from `import { env } from "cloudflare:workers"`.
const BUILD_VERSION =
  process.env.BUILD_VERSION ?? process.env.GITHUB_SHA?.slice(0, 12) ?? "dev";

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
    define: { "import.meta.env.BUILD_VERSION": JSON.stringify(BUILD_VERSION) },
  },
});
