import { z } from "zod";
import { isIsoDate } from "./dates.ts";

/**
 * Guides (SPEC.md 9.8): 20 Markdown files in `seed/guides/`, one per topic. The
 * site's content collection (apps/site/src/content.config.ts) and the content
 * checks (guide-content.test.ts) both build on the rules here. Astro bundles its
 * own zod 4, so the collection rebuilds its schema from these constants; this zod
 * 3 schema is the reference the tests use.
 */

/** The 20 topic slugs, fixed. Each is a file `seed/guides/{topic}.md`. */
export const GUIDE_TOPICS = [
  "what-is-a-golf-scramble",
  "how-charity-golf-outings-work",
  "what-an-entry-fee-includes",
  "playing-an-outing-as-a-single",
  "how-shotgun-starts-work",
  "scramble-best-ball-shamble",
  "are-charity-golf-entry-fees-tax-deductible",
  "outings-at-private-clubs",
  "outings-at-municipal-courses",
  "what-to-wear-private-club-outing",
  "mulligans-raffles-and-contests",
  "do-you-need-a-handicap",
  "sponsoring-a-hole",
  "rained-out-golf-outings",
  "organizing-a-charity-golf-outing",
  "getting-your-outing-listed",
  "outing-etiquette-for-first-timers",
  "golf-outing-season-by-region",
  "corporate-vs-charity-outings",
  "how-outing-pricing-works",
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export const GUIDE_TITLE_MAX = 80;
export const GUIDE_DESCRIPTION_MIN = 50;
export const GUIDE_DESCRIPTION_MAX = 160;
/** SPEC.md 9.4: "Guides run at least 800 original words each." */
export const GUIDE_MIN_WORDS = 800;
export const GUIDE_TOPIC_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const GUIDE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** CLAUDE.md "Site copy": words the site never uses. */
export const BANNED_COPY_WORDS = ["exclusive", "elite", "prestigious", "bucket list"] as const;

/** Frontmatter of one guide. `topic` must also equal the file name without `.md`. */
export const guideFrontmatterSchema = z
  .object({
    title: z.string().trim().min(1).max(GUIDE_TITLE_MAX),
    description: z.string().trim().min(GUIDE_DESCRIPTION_MIN).max(GUIDE_DESCRIPTION_MAX),
    topic: z.string().regex(GUIDE_TOPIC_RE, "topic must be a kebab-case slug"),
    updated: z.string().refine(isIsoDate, "updated must be an ISO date (YYYY-MM-DD)"),
    draft: z.boolean(),
  })
  .strict();
export type GuideFrontmatter = z.infer<typeof guideFrontmatterSchema>;

/** The topic a guide file name stands for: `how-shotgun-starts-work.md` gives its slug. */
export function topicFromFileName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, "").replace(/\.md$/i, "");
}

/**
 * Which guides a build includes: published ones always, drafts only in a
 * non-production build (`includeDrafts`).
 */
export function builtGuides<T extends { data: { draft: boolean } }>(guides: readonly T[], includeDrafts: boolean): T[] {
  return guides.filter((g) => includeDrafts || !g.data.draft);
}

/** Published guides only, whatever the build: what sitemaps list. */
export function publishedGuides<T extends { data: { draft: boolean } }>(guides: readonly T[]): T[] {
  return guides.filter((g) => !g.data.draft);
}

export interface GuideBodyProblem {
  line: number;
  problem: string;
}

/**
 * Body rules: `##` and `###` headings only (the page renders the title as H1), no
 * raw HTML, no images. Lines inside fenced code are ignored.
 */
export function guideBodyProblems(body: string): GuideBodyProblem[] {
  const out: GuideBodyProblem[] = [];
  let fenced = false;
  const lines = body.split(/\r?\n/);
  lines.forEach((text, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const heading = /^\s{0,3}(#{1,6})(\s|$)/.exec(text);
    if (heading && heading[1] !== "##" && heading[1] !== "###") {
      out.push({ line, problem: `heading level ${heading[1]?.length ?? 0}; use ## or ###` });
    }
    // An underline of "=" under a line of text is a setext H1.
    if (/^\s{0,3}=+\s*$/.test(text) && (lines[i - 1] ?? "").trim() !== "") {
      out.push({ line, problem: "setext H1 heading; use ##" });
    }
    if (/<\/?[a-z][a-z0-9-]*(\s[^>]*)?\/?>/i.test(text) || /<!--/.test(text)) {
      out.push({ line, problem: "raw HTML" });
    }
    if (/!\[[^\]]*\]\([^)]*\)/.test(text) || /!\[[^\]]*\]\[[^\]]*\]/.test(text)) {
      out.push({ line, problem: "image" });
    }
  });
  return out;
}

/** Words of running text: Markdown syntax and link targets don't count. */
export function guideWordCount(body: string): number {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|~-]+/g, " ");
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

export interface SplitGuide {
  /** Frontmatter as parsed key/value pairs (strings and booleans). */
  data: Record<string, string | boolean>;
  body: string;
}

function yamlScalar(raw: string): string | boolean {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    const parsed: unknown = JSON.parse(v);
    if (typeof parsed !== "string") throw new Error(`bad quoted value ${v}`);
    return parsed;
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * Splits a guide into frontmatter and body. The frontmatter is the flat
 * `key: value` subset of YAML the guides use (plain, single- or double-quoted
 * strings and booleans, one per line); anything else is an error, so a guide
 * that would need a full YAML parser fails the content check instead of passing
 * here and parsing differently in Astro.
 */
export function splitGuide(markdown: string): SplitGuide {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!m) throw new Error("missing frontmatter (a --- block at the top)");
  const data: Record<string, string | boolean> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    const value = kv?.[2]?.trim() ?? "";
    if (!kv || value === "" || /^[>|[{&*!]/.test(value)) {
      throw new Error(`frontmatter line is not a flat "key: value": ${line}`);
    }
    const key = kv[1] ?? "";
    if (Object.hasOwn(data, key)) throw new Error(`duplicate frontmatter key ${key}`);
    data[key] = yamlScalar(value);
  }
  return { data, body: m[2] ?? "" };
}

/** Banned words found in a text, case-insensitive, whole words. */
export function bannedWordsIn(text: string): string[] {
  return BANNED_COPY_WORDS.filter((w) => new RegExp(`\\b${w.replace(/\s+/g, "\\s+")}\\b`, "i").test(text));
}
