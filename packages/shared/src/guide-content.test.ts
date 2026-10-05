/**
 * Content checks for the guides in seed/guides (SPEC.md 9.4, 9.8; CLAUDE.md "Site
 * copy"). Offline: reads the Markdown files from the repo.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GUIDE_MIN_WORDS,
  GUIDE_TOPICS,
  bannedWordsIn,
  guideBodyProblems,
  guideFrontmatterSchema,
  guideWordCount,
  splitGuide,
  topicFromFileName,
} from "./guides.ts";

const GUIDES_DIR = fileURLToPath(new URL("../../../seed/guides/", import.meta.url));

const files = readdirSync(GUIDES_DIR)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .sort();

function read(file: string): { file: string; topic: string; text: string } {
  return { file, topic: topicFromFileName(file), text: readFileSync(`${GUIDES_DIR}${file}`, "utf8") };
}
const guides = files.map(read);

describe("seed/guides", () => {
  it("has exactly the 20 topic files", () => {
    expect(files.map(topicFromFileName).sort()).toEqual([...GUIDE_TOPICS].sort());
  });

  it("has only Markdown guides and the README", () => {
    const other = readdirSync(GUIDES_DIR).filter((f) => !f.endsWith(".md"));
    expect(other).toEqual([]);
  });
});

describe.each(guides)("$file", ({ topic, text }) => {
  const split = (() => {
    try {
      return { ok: true as const, ...splitGuide(text) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  })();

  it("has valid frontmatter, with the topic equal to the file name", () => {
    expect(split.ok ? null : split.error).toBeNull();
    if (!split.ok) return;
    const parsed = guideFrontmatterSchema.safeParse(split.data);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
    expect(split.data.topic).toBe(topic);
    expect(GUIDE_TOPICS as readonly string[]).toContain(topic);
  });

  it(`runs at least ${GUIDE_MIN_WORDS} words`, () => {
    if (!split.ok) return;
    expect(guideWordCount(split.body)).toBeGreaterThanOrEqual(GUIDE_MIN_WORDS);
  });

  it("uses ## and ### headings only, with no raw HTML, scripts or images", () => {
    if (!split.ok) return;
    expect(guideBodyProblems(split.body)).toEqual([]);
    expect(split.body).not.toMatch(/<script/i);
    expect(split.body).not.toMatch(/^# /m);
  });

  it("never uses the banned words", () => {
    expect(bannedWordsIn(text)).toEqual([]);
  });

  if (topic === "are-charity-golf-entry-fees-tax-deductible") {
    it("cites IRS Publication 1771 and says it is not tax advice", () => {
      expect(text).toMatch(/Publication 1771/);
      expect(text).toMatch(/not tax advice/i);
    });
  }
});
