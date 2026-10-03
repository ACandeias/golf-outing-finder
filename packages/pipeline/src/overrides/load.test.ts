import { describe, expect, it } from "vitest";
import { PATHS } from "../lib/paths.ts";
import {
  emptyOverrides,
  hostMatches,
  isExcludedUrl,
  isRemoved,
  loadOverrides,
  parseDomainsYaml,
  parseExclusionsYaml,
  parseHostsYaml,
  parseMetrosYaml,
  parseNotableCoursesYaml,
  parseRemovalsYaml,
  parseSeriesYaml,
} from "./load.ts";

describe("loadOverrides on the committed files", () => {
  it("reads and validates every override file and metros.yaml", async () => {
    const o = await loadOverrides({ overrides: PATHS.overrides, places: PATHS.places });
    expect(o.courseTypes.length).toBeGreaterThanOrEqual(13);
    expect(o.courseTypes.find((c) => c.osm_ref === "way/122734591")?.course_type).toBe("private");
    expect(o.exclusions).toEqual({ domains: [], url_patterns: [] });
    expect(o.removals).toEqual({ outing_ids: [], urls: [] });
    expect(o.notableCourses).toEqual({ names: [], osmRefs: [] });
    expect(o.series).toEqual([]);
    expect(o.accessOperators).toContain("golfwithaccess.com");
    expect(o.tournamentOperators).toContain("amateurgolf.com");
    expect(o.jsPlatforms).toEqual(expect.arrayContaining(["classy.org", "support.kidney.org"]));
    expect(o.registrationHosts).toHaveLength(16);
    expect(o.registrationHosts).toContain("qgiv.com");
    expect(o.metros).toHaveLength(500);
    expect(o.metros[0]).toMatchObject({ name: "New York City", state: "NY" });
  });

  it("returns a frozen object", async () => {
    const o = await loadOverrides({ overrides: PATHS.overrides, places: PATHS.places });
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(o.registrationHosts)).toBe(true);
    expect(() => (o.registrationHosts as string[]).push("x.com")).toThrow();
  });
});

describe("override parsers", () => {
  it("treats null lists as empty", () => {
    expect(parseRemovalsYaml("outing_ids:\nurls:\n")).toEqual({ outing_ids: [], urls: [] });
    expect(parseExclusionsYaml("")).toEqual({ domains: [], url_patterns: [] });
  });

  it("lowercases hosts and rejects URLs or junk where a host belongs", () => {
    expect(parseHostsYaml("hosts: [Classy.ORG]\n", "js-platforms.yaml")).toEqual(["classy.org"]);
    expect(() => parseHostsYaml("hosts: ['https://classy.org/']\n", "js-platforms.yaml")).toThrow(
      /js-platforms.yaml/,
    );
    expect(() => parseDomainsYaml("domains: [localhost]\n", "access-operators.yaml")).toThrow(
      /bare host/,
    );
  });

  it("rejects unknown keys so typos surface", () => {
    expect(() => parseRemovalsYaml("outing_id: [x]\n")).toThrow(/removals.yaml/);
    expect(() => parseDomainsYaml("hosts: [a.com]\n", "tournament-operators.yaml")).toThrow();
  });

  it("validates removals URLs", () => {
    expect(() => parseRemovalsYaml("urls: ['not a url']\n")).toThrow(/removals.yaml/);
    expect(() => parseRemovalsYaml("urls: ['ftp://x.example/a']\n")).toThrow();
  });

  it("reads notable courses as names and osm_refs", () => {
    expect(
      parseNotableCoursesYaml(
        "courses:\n  - Winged Foot Golf Club\n  - way/1\n  - { osm_ref: relation/2 }\n",
      ),
    ).toEqual({
      names: ["Winged Foot Golf Club"],
      osmRefs: ["way/1", "relation/2"],
    });
    expect(() => parseNotableCoursesYaml("courses:\n  - { rank: 1 }\n")).toThrow();
  });

  it("validates series entries and rejects duplicate ids", () => {
    const one =
      "series:\n  - id: nkf-golf-classic\n    name: NKF Golf Classic\n    index_url: https://www.kidney.org/golf\n";
    expect(parseSeriesYaml(one)).toEqual([
      {
        id: "nkf-golf-classic",
        name: "NKF Golf Classic",
        index_url: "https://www.kidney.org/golf",
      },
    ]);
    expect(() =>
      parseSeriesYaml(
        `${one}  - id: nkf-golf-classic\n    name: Again\n    index_url: https://x.org/\n`,
      ),
    ).toThrow(/duplicate series id/);
    expect(() =>
      parseSeriesYaml("series:\n  - id: Bad Id\n    name: x\n    index_url: https://x.org/\n"),
    ).toThrow();
  });

  it("validates metros", () => {
    expect(
      parseMetrosYaml(
        "metros:\n  - { name: Tampa, state: FL, lat: 27.9, lng: -82.4, population: 400000 }\n",
      ),
    ).toHaveLength(1);
    expect(() =>
      parseMetrosYaml(
        "metros:\n  - { name: Tampa, state: Florida, lat: 27.9, lng: -82.4, population: 1 }\n",
      ),
    ).toThrow();
  });

  it("rejects a non-mapping file", () => {
    expect(() => parseHostsYaml("- a.com\n", "registration-hosts.yaml")).toThrow(/mapping/);
  });
});

describe("override helpers", () => {
  it("matches hosts and subdomains, not lookalikes", () => {
    expect(hostMatches("www.golfwithaccess.com", ["golfwithaccess.com"])).toBe(true);
    expect(hostMatches("golfwithaccess.com", ["golfwithaccess.com"])).toBe(true);
    expect(hostMatches("notgolfwithaccess.com", ["golfwithaccess.com"])).toBe(false);
  });

  it("applies exclusion domains and URL globs", () => {
    const ex = { domains: ["spam.example"], url_patterns: ["https://club.example/members/*"] };
    expect(isExcludedUrl("https://a.spam.example/x", ex)).toBe(true);
    expect(isExcludedUrl("https://club.example/members/outing", ex)).toBe(true);
    expect(isExcludedUrl("https://club.example/events/outing", ex)).toBe(false);
    expect(isExcludedUrl("not a url", ex)).toBe(false);
  });

  it("applies removals by id or URL", () => {
    const r = { outing_ids: ["out_1"], urls: ["https://x.example/a"] };
    expect(isRemoved("out_1", [], r)).toBe(true);
    expect(isRemoved("out_2", ["https://x.example/a"], r)).toBe(true);
    expect(isRemoved("out_2", ["https://x.example/b"], r)).toBe(false);
  });

  it("builds empty overrides with a patch", () => {
    expect(emptyOverrides({ accessOperators: ["golfwithaccess.com"] }).accessOperators).toEqual([
      "golfwithaccess.com",
    ]);
  });
});
