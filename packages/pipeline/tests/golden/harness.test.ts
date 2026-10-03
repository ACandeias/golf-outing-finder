import { describe, expect, it } from "vitest";
import { stageImplemented } from "../../src/stages/registry.ts";
import { extractedEventSchema, normalizedPageSchema } from "../../src/stages/types.ts";
import {
  BMF_COLUMNS,
  eventFromSeed,
  extractableEntries,
  gate,
  GOLDEN_CASES,
  goldenContext,
  goldenEntry,
  harnessLog,
  irsLookup,
  loadCourses,
  loadIrsSubset,
  loadLlmRecording,
  loadPageFixture,
  loadSeed,
  parseBmfCsv,
  toNormalizedPage,
} from "./harness.ts";

describe("golden harness: seed", () => {
  it("has one seed entry per golden case", async () => {
    for (const gc of GOLDEN_CASES) expect((await goldenEntry(gc)).golden_case).toBe(gc);
    expect((await loadSeed()).outings).toHaveLength(32);
  });
});

describe("golden harness: pages", () => {
  it("loads a page fixture for every open, excluded and synthetic entry as a NormalizedPage", async () => {
    const entries = await extractableEntries();
    expect(entries).toHaveLength(15);
    for (const e of entries) {
      const loaded = await loadPageFixture(e.id);
      const page = toNormalizedPage(e, loaded);
      expect(normalizedPageSchema.safeParse(page).success, e.id).toBe(true);
      expect(page.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("prefers .synthetic.json for gc1 and gc5 and logs that it did", async () => {
    const gc1 = await loadPageFixture("s14-panther-national-package");
    const gc5 = await loadPageFixture("s12-grady-rocky-point");
    expect([gc1.synthetic, gc5.synthetic]).toEqual([true, true]);
    expect(gc1.fixture.http_status).toBe(200);
    expect(gc5.fixture.text).toContain("Saturday, November 7, 2026");
    expect(gc5.fixture.text).toContain("8:30 a.m.");
    expect(harnessLog).toContain(
      "s14-panther-national-package: using synthetic fixture tests/fixtures/pages/s14-panther-national-package.synthetic.json",
    );
    const recorded = await loadPageFixture("s04-fordham-winged-foot");
    expect(recorded.synthetic).toBe(false);
  });

  it("gives the synthetic s15 page a reserved .invalid URL", async () => {
    const e = await goldenEntry("gc7-oakmont-glendale");
    expect(toNormalizedPage(e, await loadPageFixture(e.id)).url).toBe(
      "https://fixtures.invalid/s15-synthetic-oakmont-glendale",
    );
  });

  it("marks directory pages with their host", async () => {
    const e = await goldenEntry("gc5-grady");
    expect(toNormalizedPage(e, await loadPageFixture(e.id))).toMatchObject({
      kind: "directory",
      directory_host: "scramblehunter.com",
    });
  });
});

describe("golden harness: LLM recordings", () => {
  it("reports a missing recording cleanly instead of throwing", async () => {
    const r = await loadLlmRecording("x99-never-recorded");
    expect(r.status).toBe("missing");
    if (r.status === "missing")
      expect(r.message).toMatch(/^no recording: tests\/fixtures\/llm\/x99-never-recorded\.json/);
    expect(harnessLog.some((l) => l.includes("x99-never-recorded: no recording"))).toBe(true);
  });

  it("gates LLM tests on both the stages and the recording", () => {
    expect(gate(["report"], "x99-never-recorded")).toEqual({
      run: false,
      reason: "no recording for x99-never-recorded",
    });
    expect(gate(["report"])).toEqual({ run: true, reason: "" });
    expect(gate(["report", "irs"]).reason).toBe(
      stageImplemented("irs") ? "" : "irs not implemented",
    );
  });
});

describe("golden harness: courses", () => {
  it("imports the recorded Overpass subset with the seed course types", async () => {
    const { courses, places } = await loadCourses();
    expect(courses.length).toBeGreaterThan(50);
    expect(places.length).toBeGreaterThan(1000);
    const glendale = courses.filter((c) => /oakmont/i.test(c.name));
    expect(new Set(glendale.map((c) => c.state))).toEqual(new Set(["CA", "PA"]));
    expect(courses.find((c) => c.osm_ref === "way/122734591")?.course_type).toBe("private");
  });
});

describe("golden harness: IRS subset", () => {
  it("has the BMF columns and a row per real nonprofit seed organizer", async () => {
    const records = await loadIrsSubset();
    expect(records).toHaveLength(22);
    expect(records.every((r) => r.ein.startsWith("99"))).toBe(true);
    expect(records.filter((r) => r.subsection === "06").map((r) => r.name)).toEqual([
      "BUILDERS INSTITUTE INC",
    ]);
    expect(records.filter((r) => r.subsection === "03")).toHaveLength(21);
    expect(BMF_COLUMNS).toHaveLength(28);
  });

  it("finds organizers by EIN and by name, within a state or nationwide", async () => {
    const irs = await irsLookup();
    expect(irs.byEin("99-0000101")?.name).toBe("NATIONAL KIDNEY FOUNDATION INC");
    expect(irs.candidates("National Kidney Foundation", "PA", 5)).toEqual([]);
    expect(irs.candidates("National Kidney Foundation", null, 5)[0]?.name).toBe(
      "NATIONAL KIDNEY FOUNDATION INC",
    );
    expect(irs.candidates("BCNY", "NY", 5)[0]?.name).toBe("BOYS CLUB OF NEW YORK");
    expect(irs.candidates("Hope & Heroes Children's Cancer Fund", "NY", 5)[0]?.sort_name).toBe(
      "HOPE AND HEROES",
    );
    // Candidates only share a token; scoring (classify, 0.92 / 0.95) decides. Grady is not in the BMF.
    expect(irs.candidates("Grady Dad's Club", null, 5).map((r) => r.name)).toEqual([
      "BOYS CLUB OF NEW YORK",
    ]);
  });

  it("rejects a file without the BMF header", () => {
    expect(() => parseBmfCsv("EIN,NAME\n1,X\n")).toThrow(/BMF/);
  });
});

describe("golden harness: context and seed events", () => {
  it("pins now to 2026-09-28 and loads the committed overrides", async () => {
    const ctx = await goldenContext();
    expect(ctx.now.toISOString()).toBe("2026-09-28T12:00:00.000Z");
    expect(ctx.overrides.tournamentOperators).toContain("amateurgolf.com");
  });

  it("turns every extractable seed entry into a valid ExtractedEvent", async () => {
    for (const e of await extractableEntries()) {
      const ev = eventFromSeed(e);
      expect(extractedEventSchema.safeParse(ev).success, e.id).toBe(true);
    }
    const grady = eventFromSeed(await goldenEntry("gc5-grady"));
    expect([grady.single_price_cents, grady.foursome_price_cents]).toEqual([15_000, 60_000]);
    expect(grady.outing_type_hint).toBe("other");
  });
});
