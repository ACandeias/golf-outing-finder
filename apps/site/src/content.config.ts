/**
 * Content collections (Astro 7 content layer). One collection: the guides in
 * `seed/guides/*.md` at the repo root (SPEC.md 9.8), plain Markdown, rendered by
 * Astro's built-in Markdown renderer. `seed/guides/README.md` is not a guide.
 *
 * The frontmatter rules live in @gof/shared/guides. Astro validates with its own
 * zod 4 (`astro/zod`), so the schema is rebuilt here from the shared constants;
 * the content check (packages/shared/src/guide-content.test.ts) validates the same
 * files with the shared zod 3 schema.
 */
import { defineCollection } from "astro:content";
import { glob, type Loader } from "astro/loaders";
import { z } from "astro/zod";
import {
  GUIDE_DESCRIPTION_MAX,
  GUIDE_DESCRIPTION_MIN,
  GUIDE_TITLE_MAX,
  GUIDE_TOPIC_RE,
  topicFromFileName,
} from "@gof/shared/guides";
import { isIsoDate } from "@gof/shared/dates";

/** YAML reads an unquoted `updated: 2026-10-04` as a Date; keep it as the date string. */
const updated = z
  .union([z.string(), z.date()])
  .transform((v) => (typeof v === "string" ? v : Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10)))
  .refine(isIsoDate, { message: "updated must be an ISO date (YYYY-MM-DD)" });

/**
 * Whether this build includes drafts, decided once in astro.config.mjs from the
 * build's NODE_ENV and passed in through Vite's `define`. (Reading
 * `process.env.NODE_ENV` here doesn't work: Vite rewrites it to the build mode.)
 */
const INCLUDE_DRAFTS = import.meta.env.GUIDE_DRAFTS === true;

/**
 * The glob loader, minus drafts in a production build, so a draft's text never
 * reaches the bundled data store, let alone a page. In dev every guide stays.
 */
function withoutDraftsInProduction(inner: Loader): Loader {
  return {
    name: "guides-glob",
    load: async (context) => {
      await inner.load(context);
      if (INCLUDE_DRAFTS) return;
      for (const entry of context.store.values()) {
        if (entry.data.draft !== false) context.store.delete(entry.id);
      }
    },
  };
}

const guides = defineCollection({
  loader: withoutDraftsInProduction(glob({
    // Relative to the Astro root (apps/site).
    base: "../../seed/guides",
    pattern: ["*.md", "!README.md"],
    // The entry id is the file name, and the frontmatter topic must match it.
    generateId: ({ entry, data }) => {
      const id = topicFromFileName(entry);
      if (data.topic !== id) {
        throw new Error(`seed/guides/${entry}: frontmatter topic "${String(data.topic)}" must equal the file name "${id}"`);
      }
      return id;
    },
  })),
  schema: z.strictObject({
    title: z.string().trim().min(1).max(GUIDE_TITLE_MAX),
    description: z.string().trim().min(GUIDE_DESCRIPTION_MIN).max(GUIDE_DESCRIPTION_MAX),
    topic: z.string().regex(GUIDE_TOPIC_RE, { message: "topic must be a kebab-case slug" }),
    updated,
    draft: z.boolean(),
  }),
});

export const collections = { guides };
