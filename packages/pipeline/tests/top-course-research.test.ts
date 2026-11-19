/** Hand-research results to seed entries: what is kept, what is rejected, and the ids. Offline. */
import { describe, expect, it } from "vitest";
import { seedEntrySchema } from "../src/seed/seed-file.ts";
import { convertResearch, researchItemSchema, stableTitle } from "../src/topcourses/research.ts";

const base = {
  course_name: "Oakmont Country Club",
  course_city: "Oakmont",
  course_state: "PA",
  organizer_name: "Example Foundation",
  outing_type: "charity",
  source_url: "https://example.org/a",
  evidence: "Organizer page shows the date.",
};
const item = (o: Record<string, unknown>) => researchItemSchema.parse({ ...base, ...o });
const existing = [
  seedEntrySchema.parse({
    id: "t99-existing",
    status: "open",
    title: "Existing Classic",
    course_name: "Oakmont Country Club",
    course_city: "Oakmont",
    course_state: "PA",
    start_date: "2027-05-01",
    source_url: "https://example.org/existing",
  }),
];
const TODAY = "2026-11-18";

describe("convertResearch", () => {
  it("keeps future and expected outings and rejects past, monthless, denied-platform and duplicate ones", () => {
    const { entries, rejected } = convertResearch(
      [
        item({ title: "28th Annual Spring Classic", status: "open", start_date: "2027-05-10", single_price_usd: 500 }),
        item({ title: "Fall Scramble", status: "expected", last_date: "2026-09-14", expected_month: "2027-09", source_url: "https://example.org/b" }),
        item({ title: "Old Outing", status: "open", start_date: "2026-10-01", source_url: "https://example.org/c" }),
        item({ title: "No Month", status: "expected", source_url: "https://example.org/d" }),
        item({ title: "Platform Only", status: "open", start_date: "2027-06-01", only_on_denied_platform: true, source_url: "https://example.org/e" }),
        item({ title: "Existing Classic", status: "open", start_date: "2027-05-01", source_url: "https://example.org/other" }),
        item({ title: "Big Ticket", status: "open", start_date: "2027-07-01", foursome_price_usd: 50_000, source_url: "https://example.org/f" }),
      ],
      { today: TODAY, existing },
    );
    expect(entries.map((e) => e.title)).toEqual(["Spring Classic", "Fall Scramble", "Big Ticket"]);
    expect(entries.map((e) => e.id.slice(0, 3))).toEqual(["t01", "t02", "t03"]);
    expect(entries[0]).toMatchObject({ start_date: "2027-05-10", single_price_usd: 500, expected_outing_type: "charity" });
    expect(entries[1]).toMatchObject({ status: "expected", start_date: null, expected_month: "2027-09" });
    expect(entries[2]?.foursome_price_usd).toBeNull();
    expect(rejected.map((r) => r.reason)).toEqual([
      "date 2026-10-01 is past",
      "expected with no month",
      "only source is a platform whose terms ban automated access",
      "duplicate of an entry already in the file",
    ]);
  });

  it("rolls ids over to the next letter after 99", () => {
    const many = Array.from({ length: 101 }, (_, i) =>
      item({ title: `Outing ${i}`, status: "open", start_date: "2027-05-10", source_url: `https://example.org/n${i}` }),
    );
    const { entries } = convertResearch(many, { today: TODAY, existing: [] });
    expect(entries.at(98)?.id.slice(0, 3)).toBe("t99");
    expect(entries.at(99)?.id.slice(0, 3)).toBe("u01");
  });

  it("drops edition numbers from titles", () => {
    expect(stableTitle("41st Annual Archbishop's Open")).toBe("Archbishop's Open");
    expect(stableTitle("The 30th Annual YMCA Legacy Golf Classic")).toBe("The YMCA Legacy Golf Classic");
    expect(stableTitle("Annual Golf Outing")).toBe("Golf Outing");
  });
});
