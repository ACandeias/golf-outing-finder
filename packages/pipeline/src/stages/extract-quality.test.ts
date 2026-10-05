/**
 * Golden-style cases for the extraction fixes after the first local nightly
 * (2026-10-04 spot check). Each fixture is a small hand-written page plus the
 * answer a model gave (or could give) despite the prompt; the zod post-check in
 * extract-collect must still get the event right.
 */
import { describe, expect, it } from "vitest";
import { EXTRACT_SYSTEM_PROMPT } from "../extract/prompt.ts";
import { meta, rawEvent, succeeded, testCtx } from "../extract/test-helpers.ts";
import { extractCollect } from "./extract-collect.ts";

const ctx = testCtx({}, new Date("2026-10-04T12:00:00.000Z"));

interface Fixture {
  url: string;
  page_text: string;
  answer: Record<string, unknown>;
}

function collect(f: Fixture) {
  const m = meta({ page_url: f.url, page_text: f.page_text });
  const out = extractCollect(ctx, { results: [succeeded(m.custom_id, { events: [rawEvent(f.answer)] })], meta: [m] });
  const page = out.output.pages[0];
  if (!page) throw new Error("no page");
  return page;
}

describe("(a) a year the page states before this year is past; a year is never inferred", () => {
  // patch.com, 2017: the article gives the day without a year; its posting date is 2017.
  const bmac: Fixture = {
    url: "https://patch.com/new-jersey/brick/support-bmac-anti-drug-programs-golf-outing-luncheon",
    page_text:
      "Support BMAC Anti-Drug Programs: Golf Outing, Luncheon. Posted Mon, Oct 2, 2017 at 5:42 pm ET. BRICK, NJ — The annual Brick Municipal Anti-Drug Coalition golf outing is next Monday, Oct. 9. The golf outing, at Eagle Ridge Golf Course in Lakewood, tees off at 8 a.m. © 2026 Patch Media",
    answer: {
      title: "Brick Municipal Anti-Drug Coalition Golf Outing",
      course_name: "Eagle Ridge Golf Course",
      venue_state: "NJ",
      start_date: "2026-10-09",
      evidence: { date: "next Monday, Oct. 9", price: null, venue: "Eagle Ridge Golf Course in Lakewood" },
    },
  };

  it("rejects the 2017 article the model dated 2026", () => {
    const p = collect(bmac);
    expect(p.events).toEqual([]);
    expect(p.rejected[0]?.reason).toMatch(/2017/);
  });

  it("rejects a date whose evidence quotes an earlier year", () => {
    const p = collect({
      url: "https://club.example/outing",
      page_text: "Annual Golf Outing Saturday, October 10, 2025 at Encanto 18. $125 per player.",
      answer: { start_date: "2026-10-10", evidence: { date: "Saturday, October 10, 2025", price: "$125 per player", venue: "Encanto 18" } },
    });
    expect(p.events).toEqual([]);
    expect(p.rejected[0]?.reason).toMatch(/2025/);
  });

  it("rejects a year that appears nowhere on the page (taken from the fetch date)", () => {
    const p = collect({
      url: "https://club.example/outing",
      page_text: "Spring Charity Scramble, Saturday October 10 at Encanto 18. $125 per player. Register today.",
      answer: { start_date: "2026-10-10", evidence: { date: "Saturday October 10", price: "$125 per player", venue: "Encanto 18" } },
    });
    expect(p.events).toEqual([]);
    expect(p.rejected[0]?.reason).toMatch(/not stated/);
  });

  it("keeps a page that states this year", () => {
    const p = collect({
      url: "https://club.example/2026-outing",
      page_text: "Spring Charity Scramble 2026. Saturday, October 10 at Encanto 18. $125 per player. Register today.",
      answer: { start_date: "2026-10-10", evidence: { date: "Saturday, October 10", price: "$125 per player", venue: "Encanto 18" } },
    });
    expect(p.events).toHaveLength(1);
  });

  it("the prompt says so", () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/Never take a year from the fetched date/);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/before the fetched year/);
  });
});

describe("(b) a free event is not an outing anyone pays to enter", () => {
  it("a $0 clinic is excluded with reject_reason other", () => {
    const p = collect({
      url: "https://club.example/clinic-2026",
      page_text: "UGA - Free Women's Golf Clinic, October 22, 2026 at Alley Pond Golf Center. Free, no experience required.",
      answer: {
        title: "UGA - Free Women's Golf clinic",
        start_date: "2026-10-22",
        single_price_usd: 0,
        foursome_price_usd: null,
        evidence: { date: "October 22, 2026", price: "Free", venue: "Alley Pond Golf Center" },
      },
    });
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ is_outing: false, reject_reason: "other" });
  });

  it("'free' with no price is excluded too; a free event with a paid golfer price is not", () => {
    const free = collect({
      url: "https://club.example/demo-2026",
      page_text: "Demo day October 22, 2026 at Encanto 18. Free admission.",
      answer: { start_date: "2026-10-22", single_price_usd: null, foursome_price_usd: null, evidence: { date: "October 22, 2026", price: "Free admission", venue: "Encanto 18" } },
    });
    expect(free.events[0]).toMatchObject({ is_outing: false, reject_reason: "other" });
    const paid = collect({
      url: "https://club.example/outing-2026",
      page_text: "Golf outing October 22, 2026 at Encanto 18. Golfers $150; dinner free for guests.",
      answer: { start_date: "2026-10-22", single_price_usd: 150, foursome_price_usd: null, evidence: { date: "October 22, 2026", price: "Golfers $150", venue: "Encanto 18" } },
    });
    expect(paid.events[0]).toMatchObject({ is_outing: true });
  });

  it("the prompt says so", () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/free event/i);
  });
});

describe("(c) a foursome price only when the page states one", () => {
  // njspba.com: "$185 per golfer"; the model wrote foursome 740.
  it("drops a foursome price that is four times the single price and not on the page", () => {
    const p = collect({
      url: "https://njspba.com/event/pba-165-golf-outing-2026/",
      page_text: "5th Annual Golf Outing. Date: Sunday, October 11, 2026. Bunker Hill Golf Course. Cost: $185 per golfer, paid prior to the event.",
      answer: { start_date: "2026-10-11", single_price_usd: 185, foursome_price_usd: 740, evidence: { date: "Sunday, October 11, 2026", price: "$185 per golfer", venue: "Bunker Hill Golf Course" } },
    });
    expect(p.events[0]).toMatchObject({ single_price_cents: 18_500, foursome_price_cents: null });
  });

  it("keeps a stated foursome price, with or without a thousands comma", () => {
    const p = collect({
      url: "https://www.zeffy.com/en-US/ticketing/2026-aoh-golf-outing",
      page_text: "2026 AOH Golf Outing, October 14, 2026. Individual Golfer $295. Foursome $1,180. Crab Meadow Golf Course.",
      answer: { start_date: "2026-10-14", single_price_usd: 295, foursome_price_usd: 1180, evidence: { date: "October 14, 2026", price: "Foursome $1,180", venue: "Crab Meadow" } },
    });
    expect(p.events[0]).toMatchObject({ single_price_cents: 29_500, foursome_price_cents: 118_000 });
  });

  it("the prompt says so", () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/never multiply the single price/i);
  });
});
