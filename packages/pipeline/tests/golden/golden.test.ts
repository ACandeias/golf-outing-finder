/**
 * Golden cases gc1 to gc8 (SPEC.md 11). Each case reads its seed entry's
 * expected_* fields and asserts them against stage outputs. A test runs once the
 * stages it uses are implemented (and, for LLM-backed checks, once
 * tests/fixtures/llm/{id}.json is recorded); until then it is reported as a todo
 * whose title says what is missing. Workstream C turns these on by replacing the
 * stage stubs; nothing in this file needs editing for that.
 */
import { describe, expect, it } from "vitest";
import { outingLabel } from "@gof/shared/labels";
import { eventStartDate } from "@gof/shared/dates";
import { planFetch } from "../../src/stages/fetch-plan.ts";
import { courseOf, classifyEvents, matchOutings, runEntry } from "./chain.ts";
import {
  eventFromSeed,
  gate,
  gateFn,
  goldenContext,
  goldenEntry,
  goldenTest,
  loadPageFixture,
} from "./harness.ts";

const LLM_CHAIN = ["extract-request-build", "extract-collect", "classify", "match"] as const;

describe("gc1-panther-national: Golf With Access package is rejected as resort_package", async () => {
  const entry = await goldenEntry("gc1-panther-national");

  it("uses the hand-written synthetic page (the live page is gone)", async () => {
    const page = await loadPageFixture(entry.id);
    expect(page.synthetic).toBe(true);
    expect(page.fixture.text).toMatch(/resort/i);
    expect(page.fixture.text).toMatch(/no golf-only/i);
  });

  goldenTest(
    "extraction rejects it as resort_package and classify excludes it",
    gate(LLM_CHAIN, entry.id),
    async () => {
      const { event, classified } = await runEntry(entry);
      expect(event.reject_reason).toBe(entry.expected_reject_reason);
      expect(classified.excluded).toBe(true);
    },
  );
});

describe("gc2-fordham: Fordham Golf Classic at Winged Foot, 2026-10-13", async () => {
  const entry = await goldenEntry("gc2-fordham");

  goldenTest(
    "a university organizer makes it a school_fundraiser, whatever the hint",
    gate(["classify"]),
    async () => {
      const [c] = await classifyEvents([eventFromSeed(entry)]);
      expect(c?.outing_type).toBe(entry.expected_outing_type);
      expect(c?.org_type).toBe("school");
    },
  );

  goldenTest("matches Winged Foot (private)", gate(["classify", "match"]), async () => {
    const [m] = await matchOutings(await classifyEvents([eventFromSeed(entry)]));
    expect((await courseOf(m!)).course_type).toBe(entry.expected_course_type);
  });

  goldenTest(
    "full chain: school_fundraiser aimed at a group, on 2026-10-13",
    gate(LLM_CHAIN, entry.id),
    async () => {
      const { event, classified, matched } = await runEntry(entry);
      expect(event.start_date).toBe(entry.start_date);
      expect(event.audience).toBe(entry.audience);
      expect(classified.outing_type).toBe(entry.expected_outing_type);
      expect(outingLabel(classified.outing_type, classified.charity_status)).toBe(
        entry.expected_display_label,
      );
      expect((await courseOf(matched)).course_type).toBe(entry.expected_course_type);
    },
  );
});

describe("gc3-builders-institute: Builders Institute at Metropolis, 2026-10-07", async () => {
  const entry = await goldenEntry("gc3-builders-institute");

  goldenTest("IRS subsection 06 makes it a business_association", gate(["classify"]), async () => {
    const [c] = await classifyEvents([eventFromSeed(entry)]);
    expect(c?.irs?.subsection).toBe("06");
    expect(c?.charity_status).toBe("other_nonprofit");
    expect(c?.outing_type).toBe(entry.expected_outing_type);
    expect(outingLabel(c!.outing_type, c!.charity_status)).toBe(entry.expected_display_label);
  });

  goldenTest("full chain", gate(LLM_CHAIN, entry.id), async () => {
    const { event, classified, matched } = await runEntry(entry);
    expect(event.start_date).toBe(entry.start_date);
    expect(classified.outing_type).toBe(entry.expected_outing_type);
    expect((await courseOf(matched)).course_type).toBe(entry.expected_course_type);
  });
});

describe("gc4-encanto: azgolf.org calendar, Encanto 18 on 2026-10-03", async () => {
  const entry = await goldenEntry("gc4-encanto");

  goldenTest(
    "extracts a list of events; Encanto is charity, unverified, at a municipal course",
    gate(LLM_CHAIN, entry.id),
    async () => {
      const { page, event, classified, matched } = await runEntry(entry, /encanto/i);
      expect(page.events.length).toBeGreaterThan(1);
      expect(event.start_date).toBe("2026-10-03");
      expect(event.organizer_name).toBeNull();
      expect(classified.outing_type).toBe(entry.expected_outing_type);
      expect(outingLabel(classified.outing_type, classified.charity_status)).toBe(
        entry.expected_display_label,
      );
      expect((await courseOf(matched)).course_type).toBe(entry.expected_course_type);
    },
  );

  goldenTest("with no organizer the label stays unverified", gate(["classify"]), async () => {
    const [c] = await classifyEvents([eventFromSeed(entry, { outing_type_hint: "charity" })]);
    expect(c?.charity_status).toBe("unverified");
    expect(outingLabel(c!.outing_type, c!.charity_status)).toBe(entry.expected_display_label);
  });
});

describe("gc5-grady: Grady scramble at Rocky Point, 2026-11-07", async () => {
  const entry = await goldenEntry("gc5-grady");

  it("uses the hand-written synthetic page (the directory hides details behind a login)", async () => {
    const page = await loadPageFixture(entry.id);
    expect(page.synthetic).toBe(true);
    expect(page.fixture.text).toContain("$150");
    expect(page.fixture.text).toContain("$600");
  });

  goldenTest("matches Rocky Point (municipal)", gate(["classify", "match"]), async () => {
    const [m] = await matchOutings(
      await classifyEvents([eventFromSeed(entry, { outing_type_hint: "school_fundraiser" })]),
    );
    expect((await courseOf(m!)).course_type).toBe(entry.expected_course_type);
  });

  goldenTest(
    "full chain: school_fundraiser, $150 single and $600 foursome",
    gate(LLM_CHAIN, entry.id),
    async () => {
      const { event, classified, matched } = await runEntry(entry);
      expect(event.start_date).toBe(entry.start_date);
      expect(event.shotgun_time).toBe(entry.shotgun_time);
      expect(event.single_price_cents).toBe(15_000);
      expect(event.foursome_price_cents).toBe(60_000);
      expect(event.registration_url).not.toBeNull();
      expect(new URL(event.registration_url!).hostname).not.toBe("scramblehunter.com");
      expect(classified.outing_type).toBe(entry.expected_outing_type);
      expect(outingLabel(classified.outing_type, classified.charity_status)).toBe(
        entry.expected_display_label,
      );
      expect((await courseOf(matched)).course_type).toBe(entry.expected_course_type);
    },
  );
});

describe("gc6-two-man-links: Two Man Links at Torrey Pines, December 15 to 18, 2026", async () => {
  const entry = await goldenEntry("gc6-two-man-links");

  goldenTest(
    "amateurgolf.com is a tournament operator: open_tournament",
    gate(["classify"]),
    async () => {
      const [c] = await classifyEvents([eventFromSeed(entry)]);
      expect(c?.outing_type).toBe(entry.expected_outing_type);
      expect(c?.org_type).toBe("tournament_operator");
      expect(c?.excluded).toBe(false);
    },
  );

  goldenTest(
    "full chain: stays in because a commuter option exists",
    gate(LLM_CHAIN, entry.id),
    async () => {
      const { event, classified, matched } = await runEntry(entry);
      expect(event.lodging_required).toBe(false);
      expect(event.start_date).toBe(entry.start_date);
      expect(event.end_date).toBe(entry.end_date);
      expect(classified.excluded).toBe(false);
      expect(classified.outing_type).toBe(entry.expected_outing_type);
      expect((await courseOf(matched)).course_type).toBe(entry.expected_course_type);
    },
  );
});

describe("gc7-oakmont-glendale: Oakmont Country Club in Glendale, CA, never Oakmont, PA", async () => {
  const entry = await goldenEntry("gc7-oakmont-glendale");

  goldenTest(
    "matches the Glendale course from the seed facts",
    gate(["classify", "match"]),
    async () => {
      // The date is in the seed's fixture_text: "Monday, March 15, 2027".
      const [m] = await matchOutings(
        await classifyEvents([eventFromSeed(entry, { start_date: "2027-03-15" })]),
      );
      const course = await courseOf(m!);
      expect(course.state).toBe("CA");
      expect(course.state).not.toBe("PA");
    },
  );

  goldenTest("full chain from the synthetic fixture text", gate(LLM_CHAIN, entry.id), async () => {
    const { event, matched } = await runEntry(entry);
    expect(event.start_date).toBe("2027-03-15");
    const course = await courseOf(matched);
    expect(course.state).toBe("CA");
  });
});

describe("gc8-nkf-winged-foot: NKF Golf Classic at Winged Foot, 2026-10-19", async () => {
  const entry = await goldenEntry("gc8-nkf-winged-foot");

  goldenTest(
    "the fetch plan renders the NKF page headlessly",
    gateFn(planFetch, "fetch"),
    async () => {
      const ctx = await goldenContext();
      const out = planFetch(ctx, {
        queue: [
          {
            url: entry.source_url!,
            found_via: "series",
            kind: "organizer",
            priority: 1,
            bypass_dedupe: true,
            recheck_outing_id: null,
            directory_host: null,
          },
        ],
        allowance: {
          MAX_FETCHES_PER_RUN: 10,
          MAX_RENDERS_PER_RUN: 10,
          MAX_FETCHES_PER_HOST_PER_RUN: 150,
        },
      });
      expect(out.output.items[0]?.render).toBe(entry.render_required);
    },
  );

  goldenTest(
    "National Kidney Foundation verifies as 501c3 nationwide: Charity",
    gate(["classify"]),
    async () => {
      const [c] = await classifyEvents([eventFromSeed(entry)]);
      expect(c?.charity_status).toBe("501c3");
      expect(c?.outing_type).toBe(entry.expected_outing_type);
      expect(outingLabel(c!.outing_type, c!.charity_status)).toBe(entry.expected_display_label);
    },
  );

  goldenTest(
    "full chain: charity at Winged Foot with a -04:00 start",
    gate(LLM_CHAIN, entry.id),
    async () => {
      const { event, classified, matched } = await runEntry(entry);
      expect(event.start_date).toBe(entry.start_date);
      expect(classified.outing_type).toBe(entry.expected_outing_type);
      expect(outingLabel(classified.outing_type, classified.charity_status)).toBe(
        entry.expected_display_label,
      );
      if (matched.match.kind !== "matched") throw new Error("unmatched");
      expect(eventStartDate(event.start_date!, event.shotgun_time, matched.match.time_zone)).toBe(
        (entry as { expected_jsonld_start?: string }).expected_jsonld_start,
      );
      expect((await courseOf(matched)).course_type).toBe(entry.expected_course_type);
    },
  );
});

describe("gc1 to gc8 through dedupe-upsert and publish into a migrated database", async () => {
  const { MemoryD1 } = await import("../../src/d1/memory.ts");
  const { dedupeUpsert } = await import("../../src/stages/dedupe-upsert.ts");
  const { publish } = await import("../../src/stages/publish.ts");
  const { outingRowSchema } = await import("../../src/stages/rows.ts");
  const { loadCourses } = await import("./harness.ts");

  goldenTest(
    "every golden page lands as one published outing, except gc1 which is excluded",
    gate([...LLM_CHAIN, "dedupe-upsert", "publish"]),
    async () => {
      const ctx = await goldenContext();
      const matchedAll = [];
      for (const gc of [
        "gc1-panther-national",
        "gc2-fordham",
        "gc3-builders-institute",
        "gc4-encanto",
        "gc5-grady",
        "gc6-two-man-links",
        "gc7-oakmont-glendale",
        "gc8-nkf-winged-foot",
      ] as const) {
        const entry = await goldenEntry(gc);
        const { matched } = await runEntry(entry, gc === "gc4-encanto" ? /encanto/i : undefined);
        matchedAll.push(matched);
      }
      const { courses } = await loadCourses();
      const d1 = new MemoryD1();
      await d1.apply({ ops: [{ op: "upsert", table: "courses", rows: courses }] });
      const up = dedupeUpsert(ctx, {
        outings: matchedAll,
        existing: { outings: [], organizers: [], sources: [], outingSlugs: [], organizerSlugs: [] },
        unchanged: [],
        fetches: [],
      });
      expect(up.output.outcomes.map((o) => o.action)).toEqual([
        "excluded",
        "insert",
        "insert",
        "insert",
        "insert",
        "insert",
        "insert",
        "insert",
      ]);
      await d1.apply(up.output.plan);
      const rows = (await d1.snapshot()).all("SELECT * FROM outings ORDER BY slug", outingRowSchema);
      const tz = new Map(courses.map((c) => [c.id, c.time_zone]));
      const pub = publish(ctx, {
        outings: rows.map((o) => ({ outing: o, time_zone: tz.get(o.course_id)!, source_urls: [] })),
        heldSources: [],
        changed: [],
      });
      await d1.apply(pub.output.plan);
      const after = (await d1.snapshot()).all("SELECT * FROM outings ORDER BY slug", outingRowSchema);
      expect(after.map((o) => [o.slug, o.published])).toEqual([
        ["2026/amateurgolf-com-two-man-links-and-father-and-son-torrey-pines-south", 1],
        ["2026/builders-institute-annual-golf-outing-metropolis", 1],
        ["2026/fordham-golf-classic-winged-foot", 1],
        ["2026/grady-charity-golf-scramble-rocky-point", 1],
        ["2026/ibew-640-25th-annual-golf-classic-encanto", 1],
        ["2026/nkf-golf-classic-winged-foot", 1],
        ["2027/charity-golf-tournament-oakmont", 1],
      ]);
      expect(pub.output.indexnowUrls).toHaveLength(7);
    },
  );
});
