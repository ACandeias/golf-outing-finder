/**
 * Guides (SPEC.md 9.8) as the site sees them. A guide is "built" when this build
 * renders its page: published guides always, drafts only in a non-production build
 * (astro.config.mjs sets `import.meta.env.GUIDE_DRAFTS`). Links go only to built
 * guides, so a production page never links to a draft. Sitemaps list published
 * guides only, whatever the build.
 */
import { getCollection, type CollectionEntry } from "astro:content";
import { builtGuides, publishedGuides, type GuideTopic } from "@gof/shared/guides";

export type Guide = CollectionEntry<"guides">;

/** Whether this build renders draft guides. */
export const GUIDE_DRAFTS: boolean = import.meta.env.GUIDE_DRAFTS === true;

export const GUIDES_PATH = "/guides";
export const guidePath = (topic: string): string => `${GUIDES_PATH}/${topic}`;

function byTitle(a: Guide, b: Guide): number {
  return a.data.title.localeCompare(b.data.title);
}

/** Guides this build renders, by title. */
export async function siteGuides(): Promise<Guide[]> {
  return builtGuides(await getCollection("guides"), GUIDE_DRAFTS).sort(byTitle);
}

/** Published guides only (sitemaps, and whether /guides is indexable). */
export async function publishedSiteGuides(): Promise<Guide[]> {
  return publishedGuides(await getCollection("guides")).sort(byTitle);
}

export interface GuideLink {
  topic: string;
  title: string;
  path: string;
}

/** Links to the given topics that this build renders, in the order asked. */
export async function guideLinks(topics: readonly GuideTopic[]): Promise<GuideLink[]> {
  const built = new Map((await siteGuides()).map((g) => [g.id, g]));
  return topics.flatMap((t) => {
    const g = built.get(t);
    return g ? [{ topic: t, title: g.data.title, path: guidePath(t) }] : [];
  });
}

/** Whether the guides index has anything to link to in this build. */
export async function hasGuides(): Promise<boolean> {
  return (await siteGuides()).length > 0;
}
