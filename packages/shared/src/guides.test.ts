import { describe, expect, it } from "vitest";
import {
  GUIDE_TOPICS,
  bannedWordsIn,
  builtGuides,
  guideBodyProblems,
  guideFrontmatterSchema,
  guideWordCount,
  publishedGuides,
  splitGuide,
  topicFromFileName,
} from "./guides.ts";

const good = {
  title: "How Shotgun Starts Work",
  description: "What a shotgun start is, why outings use one, and when to arrive so you make your starting hole.",
  topic: "how-shotgun-starts-work",
  updated: "2026-10-04",
  draft: true,
};

describe("guide frontmatter schema", () => {
  it("accepts a valid guide", () => {
    expect(guideFrontmatterSchema.parse(good)).toEqual(good);
  });

  it("enforces the title, description, topic, date and draft rules", () => {
    const bad = (patch: Record<string, unknown>): boolean => !guideFrontmatterSchema.safeParse({ ...good, ...patch }).success;
    expect(bad({ title: "x".repeat(81) })).toBe(true);
    expect(bad({ title: "x".repeat(80) })).toBe(false);
    expect(bad({ description: "Too short." })).toBe(true);
    expect(bad({ description: "x".repeat(161) })).toBe(true);
    expect(bad({ description: "x".repeat(50) })).toBe(false);
    expect(bad({ topic: "How_Shotgun" })).toBe(true);
    expect(bad({ updated: "2026-02-30" })).toBe(true);
    expect(bad({ updated: "Oct 4, 2026" })).toBe(true);
    expect(bad({ draft: "yes" })).toBe(true);
    expect(bad({ draft: undefined })).toBe(true);
    expect(bad({ author: "someone" })).toBe(true);
  });

  it("has 20 unique kebab-case topics", () => {
    expect(GUIDE_TOPICS).toHaveLength(20);
    expect(new Set(GUIDE_TOPICS).size).toBe(20);
    for (const t of GUIDE_TOPICS) expect(t).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("splitGuide", () => {
  it("reads flat frontmatter with plain and quoted strings and booleans", () => {
    const md = [
      "---",
      'title: "What Is a Golf Scramble?"',
      "description: 'It''s the most common outing format.'",
      "topic: what-is-a-golf-scramble",
      "updated: 2026-10-04",
      "draft: false",
      "---",
      "",
      "## Body",
    ].join("\n");
    const { data, body } = splitGuide(md);
    expect(data).toEqual({
      title: "What Is a Golf Scramble?",
      description: "It's the most common outing format.",
      topic: "what-is-a-golf-scramble",
      updated: "2026-10-04",
      draft: false,
    });
    expect(body.trim()).toBe("## Body");
  });

  it("rejects missing frontmatter, nested YAML and duplicate keys", () => {
    expect(() => splitGuide("## No frontmatter")).toThrow(/frontmatter/);
    expect(() => splitGuide("---\ntitle: >\n  folded\n---\n")).toThrow(/flat/);
    expect(() => splitGuide("---\ntitle: a\ntitle: b\n---\n")).toThrow(/duplicate/);
  });
});

describe("guide body rules", () => {
  it("allows ## and ### only", () => {
    expect(guideBodyProblems("## Section\n\n### Sub\n\nText.")).toEqual([]);
    expect(guideBodyProblems("# Title")[0]?.problem).toMatch(/level 1/);
    expect(guideBodyProblems("#### Deep")[0]?.problem).toMatch(/level 4/);
    expect(guideBodyProblems("Title\n=====")[0]?.problem).toMatch(/setext/);
    // A # inside a code fence is not a heading.
    expect(guideBodyProblems("```\n# not a heading\n```")).toEqual([]);
  });

  it("flags raw HTML, comments and images", () => {
    expect(guideBodyProblems("<script>alert(1)</script>").map((p) => p.problem)).toContain("raw HTML");
    expect(guideBodyProblems("A <br/> break").map((p) => p.problem)).toContain("raw HTML");
    expect(guideBodyProblems("<!-- note -->").map((p) => p.problem)).toContain("raw HTML");
    expect(guideBodyProblems("![logo](/x.png)").map((p) => p.problem)).toContain("image");
    // Comparisons and arrows in prose are fine.
    expect(guideBodyProblems("Fees run < $200 and > $100.")).toEqual([]);
  });

  it("counts words of running text, not Markdown or link targets", () => {
    expect(guideWordCount("## Two words\n\nOne [two three](https://example.com/a-b-c) four.")).toBe(6);
    expect(guideWordCount("- a\n- b\n\n| x | y |\n| - | - |")).toBe(4);
  });

  it("finds banned words case-insensitively", () => {
    expect(bannedWordsIn("An Exclusive day")).toEqual(["exclusive"]);
    expect(bannedWordsIn("a BUCKET  list course")).toEqual(["bucket list"]);
    expect(bannedWordsIn("Elitesque is not a word we ban")).toEqual([]);
  });
});

describe("which guides a build includes", () => {
  const guides = [{ id: "a", data: { draft: false } }, { id: "b", data: { draft: true } }];
  it("drafts only when the build includes them; sitemaps never", () => {
    expect(builtGuides(guides, false).map((g) => g.id)).toEqual(["a"]);
    expect(builtGuides(guides, true).map((g) => g.id)).toEqual(["a", "b"]);
    expect(publishedGuides(guides).map((g) => g.id)).toEqual(["a"]);
  });

  it("maps file names to topics", () => {
    expect(topicFromFileName("how-shotgun-starts-work.md")).toBe("how-shotgun-starts-work");
    expect(topicFromFileName("seed/guides/sponsoring-a-hole.md")).toBe("sponsoring-a-hole");
  });
});
