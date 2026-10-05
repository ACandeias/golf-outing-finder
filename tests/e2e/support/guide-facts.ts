/**
 * The guides in seed/guides, read from disk so the suite follows whatever guides
 * exist (two development placeholders now, the 20 drafts later, published ones
 * after the owner's review). The e2e build runs with NODE_ENV=development, so it
 * renders drafts too (apps/site/astro.config.mjs); sitemaps list published guides
 * only, in every build.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitGuide, topicFromFileName } from "../../../packages/shared/src/guides.ts";

export interface GuideFact {
  topic: string;
  title: string;
  draft: boolean;
  updated: string;
  path: string;
}

const DIR = fileURLToPath(new URL("../../../seed/guides/", import.meta.url));

export const GUIDES: readonly GuideFact[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .sort()
  .map((f) => {
    const { data } = splitGuide(readFileSync(`${DIR}${f}`, "utf8"));
    const topic = topicFromFileName(f);
    return {
      topic,
      title: String(data.title ?? ""),
      draft: data.draft !== false,
      updated: String(data.updated ?? ""),
      path: `/guides/${topic}`,
    };
  });

export const DRAFT_GUIDES = GUIDES.filter((g) => g.draft);
export const PUBLISHED_GUIDES = GUIDES.filter((g) => !g.draft);

/** One guide page for the page-wide checks (JSON-LD, headers, axe). */
export const SAMPLE_GUIDE_PATH: string = GUIDES[0]?.path ?? "/guides";

/** e2e value of the INDEXNOW_KEY Worker var (global-setup.ts). */
export const E2E_INDEXNOW_KEY = "test-indexnow-key-0001";
/** e2e values of the verification Worker vars (global-setup.ts). */
export const E2E_GOOGLE_VERIFICATION = "e2e-google-verification-token";
export const E2E_BING_VERIFICATION = "E2EBINGVERIFICATION0123456789AB";
