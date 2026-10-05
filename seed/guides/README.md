Guides (SPEC.md section 9.8): one plain Markdown file per topic, named `{topic}.md`, for the 20 topics in `packages/shared/src/guides.ts`.

Frontmatter, flat `key: value` lines only:

    ---
    title: How Shotgun Starts Work            (80 characters at most)
    description: One or two sentences.        (50 to 160 characters)
    topic: how-shotgun-starts-work            (the file name without .md)
    updated: 2026-10-04                       (YYYY-MM-DD)
    draft: true                               (false once the owner has reviewed it)
    ---

Body: at least 800 words; `##` and `###` headings only (the page shows the title as the H1); no raw HTML, no images. `pnpm test` checks all of this (packages/shared/src/guide-content.test.ts).

Drafts build only when the build's NODE_ENV isn't production (`pnpm dev`, the e2e build). They carry noindex and never appear in sitemaps or production links.
